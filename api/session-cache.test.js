process.env.WORKER_SECRET = "test-secret";
process.env.GITHUB_TOKEN = "";
process.env.WORKER_URL = "";

const assert = require("assert");
const http = require("http");
const { server, resultCache, resetForTests, setDispatchForTests, LIVE_SOURCE_IDS } = require("./server");

const ADDRESS = "9515 Jaywood Drive Houston TX 77040";
const ADDRESS_DR = "9515 Jaywood Dr, Houston, TX 77040";

function request(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: Object.assign({
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      }, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        if (raw) json = JSON.parse(raw);
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function doneBody(sessionId, sourceId, value) {
  return {
    sessionId,
    address: ADDRESS,
    sourceId,
    status: "done",
    value,
    low: value - 10000,
    high: value + 10000,
  };
}

(async () => {
  resetForTests();
  const calls = [];
  setDispatchForTests((session, sourceIds) => {
    calls.push({ id: session.id, sourceIds });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const auth = { Authorization: "Bearer test-secret" };

  const created = await request(port, "POST", "/sessions", { address: ADDRESS });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].sourceIds, LIVE_SOURCE_IDS);

  const rate = await request(port, "POST", "/callbacks", doneBody(created.json.sessionId, "rate", 310000), auth);
  assert.strictEqual(rate.status, 204);
  const blocked = await request(port, "POST", "/callbacks", {
    sessionId: created.json.sessionId,
    address: ADDRESS,
    sourceId: "har",
    status: "unavailable",
    error: "HAR.com blocked the address search.",
  }, auth);
  assert.strictEqual(blocked.status, 204);
  assert.strictEqual(resultCache.get(ADDRESS_DR).rate.value, 310000);
  assert.strictEqual(resultCache.get(ADDRESS).har, undefined);

  calls.length = 0;
  const repeat = await request(port, "POST", "/sessions", { address: ADDRESS_DR });
  assert.strictEqual(repeat.status, 201);
  assert.deepStrictEqual(calls[0].sourceIds, ["homebot", "chase", "har"]);
  const repeatGet = await request(port, "GET", "/sessions/" + repeat.json.sessionId);
  const rateRow = repeatGet.json.sources.find((row) => row.id === "rate");
  const harRow = repeatGet.json.sources.find((row) => row.id === "har");
  assert.strictEqual(rateRow.status, "done");
  assert.strictEqual(rateRow.value, 310000);
  assert.strictEqual(harRow.status, "pending");
  assert.strictEqual(repeatGet.json.sources.some((row) => row.id === "redfin" || row.id === "zillow" || row.id === "homes"), false);

  calls.length = 0;
  const claimed = await request(port, "POST", "/sessions", { address: ADDRESS_DR, have: ["chase", "redfin"] });
  assert.strictEqual(claimed.status, 201);
  assert.deepStrictEqual(calls[0].sourceIds, ["homebot", "har"]);

  for (const sourceId of LIVE_SOURCE_IDS) {
    if (resultCache.get(ADDRESS)[sourceId]) continue;
    const posted = await request(port, "POST", "/callbacks", doneBody(created.json.sessionId, sourceId, 300000 + sourceId.length), auth);
    assert.strictEqual(posted.status, 204);
  }
  calls.length = 0;
  for (let i = 0; i < 20; i += 1) {
    const hit = await request(port, "POST", "/sessions", { address: ADDRESS_DR });
    assert.strictEqual(hit.status, 201);
    const view = await request(port, "GET", "/sessions/" + hit.json.sessionId);
    assert.ok(view.json.sources.every((row) => row.status === "done" && typeof row.value === "number"));
  }
  assert.strictEqual(calls.length, 0);

  const orphanId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const orphan = await request(port, "POST", "/callbacks", {
    sessionId: orphanId,
    address: "5539 Darling St, Houston, TX 77007",
    sourceId: "chase",
    status: "done",
    value: 420000,
  }, auth);
  assert.strictEqual(orphan.status, 204);
  calls.length = 0;
  const darling = await request(port, "POST", "/sessions", { address: "5539 Darling Street, Houston, TX 77007" });
  assert.strictEqual(darling.status, 201);
  assert.deepStrictEqual(calls[0].sourceIds, ["homebot", "rate", "har"]);
  const darlingGet = await request(port, "GET", "/sessions/" + darling.json.sessionId);
  assert.strictEqual(darlingGet.json.sources.find((row) => row.id === "chase").value, 420000);

  server.close();
  process.stdout.write("session cache tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
