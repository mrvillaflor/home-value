/*
 * In-memory session API for the home-value page.
 *
 * POST /sessions          { address } → { sessionId }
 * GET  /sessions/:id      one row per source
 * POST /callbacks         worker result, Bearer WORKER_SECRET
 * GET  /health
 *
 * Only Redfin is sent to the worker. The other sources stay pending.
 * Nothing is written to disk. Render's free instance can forget this
 * memory whenever it sleeps.
 */

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 10000;
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const LIVE_SOURCE_ID = "redfin";

const SOURCES = [
  { id: "redfin", name: "Redfin" },
  { id: "homebot", name: "Homebot" },
  { id: "zillow", name: "Zillow" },
  { id: "chase", name: "Chase" },
  { id: "pennymac", name: "PennyMac" },
  { id: "homes", name: "Homes.com" },
  { id: "rate", name: "Rate.com" },
];

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

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
  if (origin === "https://mrvillaflor.github.io") return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
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
  };
}

function dispatchWorker(req, session) {
  const rowPatch = (patch) => markSource(session, LIVE_SOURCE_ID, patch);

  if (!WORKER_URL || !WORKER_SECRET) {
    rowPatch({
      status: "unavailable",
      value: null,
      low: null,
      high: null,
      fetchedAt: new Date().toISOString(),
      error: "The lookup service is not configured.",
    });
    return;
  }

  const callbackUrl = publicBase(req) + "/callbacks";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

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
      sourceId: LIVE_SOURCE_ID,
    }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (response.status !== 202 && !response.ok) {
        rowPatch({
          status: "unavailable",
          value: null,
          low: null,
          high: null,
          fetchedAt: new Date().toISOString(),
          error: "The lookup service did not accept the address.",
        });
      }
    })
    .catch(() => {
      rowPatch({
        status: "unavailable",
        value: null,
        low: null,
        high: null,
        fetchedAt: new Date().toISOString(),
        error: "The lookup service did not respond.",
      });
    })
    .finally(() => clearTimeout(timer));
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
    send(res, 200, { ok: true });
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
    pruneSessions();
    const session = {
      id: crypto.randomUUID(),
      address,
      createdAt: Date.now(),
      sources: SOURCES.map(blankSource),
    };
    sessions.set(session.id, session);
    dispatchWorker(req, session);
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
    const session = sessions.get(body.sessionId);
    if (!session) {
      send(res, 404, { error: "Session not found" });
      return;
    }
    if (body.sourceId !== LIVE_SOURCE_ID) {
      send(res, 400, { error: "Only the live source can be updated." });
      return;
    }
    const result = normalizeResult(body);
    if (!result) {
      send(res, 400, { error: "Result needs status done or unavailable, and a real value when done." });
      return;
    }
    markSource(session, LIVE_SOURCE_ID, result);
    send(res, 204, null);
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  process.stdout.write("home-value-api listening on " + PORT + "\n");
});
