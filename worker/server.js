/*
 * Playwright worker. POST /jobs accepts a lookup and returns 202.
 * The scrape runs afterward and the result is posted to callbackUrl.
 * Authorization: Bearer WORKER_SECRET
 */

const http = require("http");
const crypto = require("crypto");
const { scrapeRedfin } = require("./scrape");

const PORT = Number(process.env.PORT) || 8080;
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const CHROME_PATH = process.env.CHROME_PATH || "";

let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
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

function send(res, status, body) {
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
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
      try {
        resolve(size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function callbackAllowed(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch (error) {
    return false;
  }
}

async function postCallback(job, outcome) {
  const response = await fetch(job.callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + WORKER_SECRET,
    },
    body: JSON.stringify({
      sessionId: job.sessionId,
      sourceId: "redfin",
      status: outcome.status,
      value: outcome.value,
      low: outcome.low,
      high: outcome.high,
      fetchedAt: outcome.fetchedAt,
      error: outcome.error,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok && response.status !== 204) {
    throw new Error("Callback failed with " + response.status);
  }
}

async function runJob(job) {
  const outcome = await scrapeRedfin(job.address, {
    chromePath: CHROME_PATH,
    timeoutMs: 40000,
  });
  await postCallback(job, outcome);
  process.stdout.write("job " + job.sessionId + " " + outcome.status + "\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/jobs") {
    if (!WORKER_SECRET) {
      send(res, 503, { error: "WORKER_SECRET is not set." });
      return;
    }
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
    const address = typeof body.address === "string" ? body.address.trim().replace(/\s+/g, " ") : "";
    if (!body.sessionId || address.length < 8 || !callbackAllowed(body.callbackUrl)) {
      send(res, 400, { error: "sessionId, address, and callbackUrl are required." });
      return;
    }
    if (body.sourceId && body.sourceId !== "redfin") {
      send(res, 400, { error: "This worker only looks up Redfin." });
      return;
    }
    const job = {
      sessionId: String(body.sessionId),
      address,
      callbackUrl: body.callbackUrl,
    };
    send(res, 202, { accepted: true });
    enqueue(() => runJob(job)).catch((error) => {
      process.stderr.write("job " + job.sessionId + " failed " + error.message + "\n");
    });
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  process.stdout.write("home-value-worker listening on " + PORT + "\n");
});
