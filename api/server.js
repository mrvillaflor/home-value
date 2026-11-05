/*
 * In-memory session API for the home-value page.
 *
 * POST /sessions          { address, have? } → { sessionId }
 * GET  /sessions/:id      one row per source
 * POST /callbacks         worker result, Bearer WORKER_SECRET
 * GET  /health
 *
 * Homebot, Chase, Rate.com, and HAR.com are the live sources.
 * A successful estimate is remembered for 24 hours, per source, under
 * the normalized address. Unavailable results are not remembered.
 * Nothing is written to disk. Render's free instance can forget this
 * memory whenever it sleeps.
 */

const http = require("http");
const crypto = require("crypto");
const { dispatchGitHubWorkflow } = require("./dispatch");
const { createLimiter } = require("./limits");
const { cacheKey } = require("./address");
const { createStore, freshMap, remember, TTL_MS } = require("./result-cache");

const PORT = Number(process.env.PORT) || 10000;
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "mrvillaflor/home-value";
const GITHUB_WORKFLOW = process.env.GITHUB_WORKFLOW || "lookup.yml";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://mrvillaflor.github.io";
const DAILY_CAP = Number(process.env.DAILY_CAP || 100);
const LIVE_SOURCE_IDS = ["homebot", "chase", "rate", "har"];
let limiter = createLimiter({
  dailyCap: Number.isFinite(DAILY_CAP) && DAILY_CAP > 0 ? DAILY_CAP : 100,
});

const SOURCES = [
  { id: "homebot", name: "Homebot" },
  { id: "chase", name: "Chase" },
  { id: "rate", name: "Rate.com" },
  { id: "har", name: "HAR.com" },
];

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const resultStore = createStore();
const resultCache = {
  get(address, now = Date.now()) {
    return freshMap(resultStore, cacheKey(address), now, TTL_MS);
  },
  put(address, sourceId, result, now = Date.now()) {
    return remember(resultStore, cacheKey(address), sourceId, result, now, TTL_MS);
  },
  clear() {
    resultStore.entries = {};
  },
};
let dispatchOverride = null;

function isFullAddress(value) {
  if (typeof value !== "string") return false;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length < 8 || text.length > 200) return false;
  if (!/\d/.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  return true;
}

function blankSource(source) {
  return {
    id: source.id,
    name: source.name,
    status: "pending",
    value: null,
    low: null,
    high: null,
    fetchedAt: null,
    error: null,
  };
}

function publicBase(req) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  }
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/$/, "");
  }
  const host = req.headers.host || "localhost";
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (typeof forwarded === "string" ? forwarded.split(",")[0] : "http").trim();
  return proto + "://" + host;
}

function allowOrigin(origin) {
  if (!origin) return false;
  if (origin === ALLOWED_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (allowOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function send(res, status, body) {
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function secretMatches(header) {
  if (!WORKER_SECRET || typeof header !== "string") return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(WORKER_SECRET);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10000) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}

function markSource(session, sourceId, patch) {
  const row = session.sources.find((source) => source.id === sourceId);
  if (!row) return false;
  Object.assign(row, patch);
  return true;
}

function normalizeResult(body) {
  const status = body && body.status;
  if (status !== "done" && status !== "unavailable") return null;
  let value = null;
  let low = null;
  let high = null;
  if (status === "done") {
    if (typeof body.value !== "number" || !Number.isFinite(body.value)) return null;
    value = Math.round(body.value);
    if (typeof body.low === "number" && Number.isFinite(body.low) && typeof body.high === "number" && Number.isFinite(body.high)) {
      low = Math.round(Math.min(body.low, body.high));
      high = Math.round(Math.max(body.low, body.high));
      if (low > value || high < value) {
        low = null;
        high = null;
      }
    }
  }
  const error = typeof body.error === "string" ? body.error.replace(/\s+/g, " ").trim().slice(0, 180) : null;
  return {
    status: status === "done" ? "done" : "unavailable",
    value: status === "done" ? value : null,
    low: status === "done" ? low : null,
    high: status === "done" ? high : null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? error || "No estimate returned" : null,
    estimates: status === "done" ? normalizeEstimates(body.estimates) : null,
    url: status === "done" ? normalizeHarUrl(body.url) : null,
  };
}

function roundMoney(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const value = Math.round(raw);
  if (value < 10000 || value > 100000000) return null;
  return value;
}

function normalizeEstimates(rows) {
  if (!Array.isArray(rows)) return null;
  const allowed = ["ICE", "Cotality", "Appraisal District"];
  const estimates = [];
  for (const row of rows.slice(0, 3)) {
    if (!row || !allowed.includes(row.name)) continue;
    const value = roundMoney(row.value);
    if (value == null) continue;
    let low = null;
    let high = null;
    if (typeof row.low === "number" && typeof row.high === "number") {
      low = Math.round(Math.min(row.low, row.high));
      high = Math.round(Math.max(row.low, row.high));
      if (low > value || high < value || low < 10000 || high > 100000000) {
        low = null;
        high = null;
      }
    }
    let confidence = null;
    if (typeof row.confidence === "number" && row.confidence >= 1 && row.confidence <= 100) {
      confidence = Math.round(row.confidence);
    }
    let year = null;
    if (typeof row.year === "number" && row.year >= 1990 && row.year <= 2099) year = Math.round(row.year);
    const prior = [];
    if (Array.isArray(row.prior)) {
      for (const item of row.prior.slice(0, 4)) {
        const priorValue = roundMoney(item && item.value);
        const priorYear = item && typeof item.year === "number" ? Math.round(item.year) : null;
        if (priorValue == null || priorYear == null || priorYear < 1990 || priorYear > 2099) continue;
        prior.push({ year: priorYear, value: priorValue });
      }
    }
    estimates.push({ name: row.name, value, low, high, confidence, year, prior });
  }
  return estimates.length ? estimates : null;
}

function normalizeHarUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.har.com") return null;
    if (!/^\/homedetail\/[a-z0-9-]+\/\d+\/?$/i.test(url.pathname)) return null;
    if (url.search || url.hash) return null;
    return "https://www.har.com" + url.pathname.replace(/\/$/, "");
  } catch (error) {
    return null;
  }
}

function markUnavailable(session, error) {
  for (const sourceId of LIVE_SOURCE_IDS) {
    const row = session.sources.find((source) => source.id === sourceId);
    if (!row || row.status !== "pending") continue;
    markSource(session, sourceId, {
      status: "unavailable",
      value: null,
      low: null,
      high: null,
      fetchedAt: new Date().toISOString(),
      error,
    });
  }
}

function cachedSource(source, result) {
  return {
    id: source.id,
    name: source.name,
    status: "done",
    value: result.value,
    low: result.low == null ? null : result.low,
    high: result.high == null ? null : result.high,
    fetchedAt: result.fetchedAt || new Date().toISOString(),
    error: null,
    estimates: result.estimates || null,
    url: result.url || null,
  };
}

function claimedSources(body) {
  if (!body || !Array.isArray(body.have)) return [];
  return [...new Set(body.have.filter((id) => typeof id === "string" && LIVE_SOURCE_IDS.includes(id)))];
}

function dispatchHttpWorker(session, callbackUrl, sourceIds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  fetch(WORKER_URL + "/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + WORKER_SECRET,
    },
    body: JSON.stringify({
      sessionId: session.id,
      address: session.address,
      callbackUrl,
      sourceId: sourceIds.join(","),
    }),
    signal: controller.signal,
  })
    .then((response) => {
      if (response.status !== 202 && !response.ok) {
        markUnavailable(session, "The lookup service did not accept the address.");
      }
    })
    .catch(() => {
      markUnavailable(session, "The lookup service did not respond.");
    })
    .finally(() => clearTimeout(timer));
}

function dispatchWorker(req, session, sourceIds) {
  if (dispatchOverride) {
    dispatchOverride(session, sourceIds.slice());
    return;
  }
  const callbackUrl = publicBase(req) + "/callbacks";

  if (WORKER_URL) {
    if (!WORKER_SECRET) {
      markUnavailable(session, "The lookup service is not configured.");
      return;
    }
    dispatchHttpWorker(session, callbackUrl, sourceIds);
    return;
  }

  if (!GITHUB_TOKEN || !WORKER_SECRET) {
    markUnavailable(session, "The lookup service is not configured.");
    return;
  }

  dispatchGitHubWorkflow({
    token: GITHUB_TOKEN,
    repo: GITHUB_REPO,
    workflow: GITHUB_WORKFLOW,
    ref: "main",
    inputs: {
      sessionId: session.id,
      address: session.address,
      sourceId: sourceIds.join(","),
      callbackUrl,
    },
  })
    .then(() => {
      process.stdout.write("dispatched " + session.id + "\n");
    })
    .catch((error) => {
      const status = error && error.status ? " " + error.status : "";
      process.stdout.write("dispatch failed " + session.id + status + "\n");
      markUnavailable(session, "The lookup service did not start.");
    });
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true, live: LIVE_SOURCE_IDS });
    return;
  }

  if (req.method === "POST" && url.pathname === "/sessions") {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      send(res, 400, { error: "Invalid JSON" });
      return;
    }
    const address = typeof body.address === "string" ? body.address.trim().replace(/\s+/g, " ") : "";
    if (!isFullAddress(address)) {
      send(res, 400, { error: "Enter a full street address, including city and state." });
      return;
    }
    const cached = resultCache.get(address);
    const have = claimedSources(body);
    const missing = LIVE_SOURCE_IDS.filter((id) => !cached[id] && !have.includes(id));
    const fullyCached = LIVE_SOURCE_IDS.every((id) => cached[id]);
    if (!fullyCached) {
      const limit = limiter.check(clientIp(req));
      if (!limit.ok) {
        const error = limit.reason === "daily"
          ? "The lookup limit for today has been reached."
          : "Too many lookups from this network. Try again in a few minutes.";
        send(res, 429, { error });
        return;
      }
    }
    pruneSessions();
    const session = {
      id: crypto.randomUUID(),
      address,
      createdAt: Date.now(),
      sources: SOURCES.map((source) => (cached[source.id] ? cachedSource(source, cached[source.id]) : blankSource(source))),
    };
    sessions.set(session.id, session);
    if (missing.length) dispatchWorker(req, session, missing);
    send(res, 201, { sessionId: session.id });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    if (!session) {
      send(res, 404, { error: "Session not found" });
      return;
    }
    send(res, 200, {
      sessionId: session.id,
      address: session.address,
      sources: session.sources,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/callbacks") {
    if (!secretMatches(req.headers.authorization)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      send(res, 400, { error: "Invalid JSON" });
      return;
    }
    let session = sessions.get(body.sessionId);
    if (!session) {
      // Render's free instance drops memory on restart. Keep the result
      // the worker already fetched instead of answering 404.
      if (typeof body.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.sessionId)) {
        send(res, 404, { error: "Session not found" });
        return;
      }
      const address = typeof body.address === "string" ? body.address.trim().replace(/\s+/g, " ").slice(0, 200) : "";
      session = {
        id: body.sessionId,
        address,
        createdAt: Date.now(),
        sources: SOURCES.map(blankSource),
      };
      sessions.set(session.id, session);
    }
    if (!LIVE_SOURCE_IDS.includes(body.sourceId)) {
      send(res, 400, { error: "Only a live source can be updated." });
      return;
    }
    const result = normalizeResult(body);
    if (!result) {
      send(res, 400, { error: "Result needs status done or unavailable, and a real value when done." });
      return;
    }
    markSource(session, body.sourceId, result);
    const cacheAddress = session.address || (typeof body.address === "string" ? body.address : "");
    if (result.status === "done") resultCache.put(cacheAddress, body.sourceId, result);
    send(res, 204, null);
    return;
  }

  send(res, 404, { error: "Not found" });
});

function resetForTests() {
  sessions.clear();
  resultCache.clear();
  dispatchOverride = null;
  limiter = createLimiter({
    dailyCap: Number.isFinite(DAILY_CAP) && DAILY_CAP > 0 ? DAILY_CAP : 100,
  });
}

function setDispatchForTests(fn) {
  dispatchOverride = fn;
}

if (require.main === module) {
  server.listen(PORT, () => {
    process.stdout.write("home-value-api listening on " + PORT + "\n");
  });
}

module.exports = {
  server,
  resultCache,
  resetForTests,
  setDispatchForTests,
  LIVE_SOURCE_IDS,
};
