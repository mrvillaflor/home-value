/*
 * Spawns the real run-once.js against a local callback stub.
 * LOOKUP_DRY_RUN skips the scrapers. A missing `address` binding
 * still throws inside postResult and fails this test.
 */

const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");

const ADDRESS = "9515 Jaywood Dr, Houston, TX 77040";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function listen(statusCode) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(statusCode);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run-once.js"], {
      cwd: __dirname,
      env: Object.assign({}, process.env, env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

(async () => {
  const ok = await listen(204);
  const success = await run({
    ADDRESS,
    SESSION_ID,
    SOURCE_ID: "rate,har",
    CALLBACK_URL: "http://127.0.0.1:" + ok.port + "/callbacks",
    WORKER_SECRET: "test-secret",
    LOOKUP_DRY_RUN: "1",
  });
  ok.server.close();
  assert.strictEqual(success.code, 0, success.stderr);
  assert.ok(!success.stderr.includes("address is not defined"), success.stderr);
  assert.strictEqual(ok.requests.length, 2);
  const sourceIds = ok.requests.map((item) => item.body.sourceId).sort();
  assert.deepStrictEqual(sourceIds, ["har", "rate"]);
  for (const item of ok.requests) {
    assert.strictEqual(item.authorization, "Bearer test-secret");
    assert.strictEqual(item.body.address, ADDRESS);
    assert.strictEqual(item.body.sessionId, SESSION_ID);
    assert.ok(item.body.status === "done" || item.body.status === "unavailable");
  }
  assert.ok(ok.requests.some((item) => item.body.status === "done" && item.body.value === 250000));

  const remote = await run({
    ADDRESS,
    SESSION_ID,
    SOURCE_ID: "rate",
    CALLBACK_URL: "https://example.com/callbacks",
    WORKER_SECRET: "test-secret",
    LOOKUP_DRY_RUN: "1",
  });
  assert.strictEqual(remote.code, 1);
  assert.match(remote.stderr, /localhost/);

  const failing = await listen(500);
  const failed = await run({
    ADDRESS,
    SESSION_ID,
    SOURCE_ID: "rate",
    CALLBACK_URL: "http://127.0.0.1:" + failing.port + "/callbacks",
    WORKER_SECRET: "test-secret",
    LOOKUP_DRY_RUN: "1",
  });
  failing.server.close();
  assert.strictEqual(failed.code, 1);
  assert.match(failed.stderr, /Callback failed with 500/);
  assert.ok(!failed.stderr.includes("address is not defined"));
  assert.strictEqual(failing.requests[0].body.address, ADDRESS);

  process.stdout.write("run-once callback tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
