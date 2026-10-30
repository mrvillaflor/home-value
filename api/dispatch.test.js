const assert = require("assert");
const { dispatchGitHubWorkflow } = require("./dispatch");
const { createLimiter } = require("./limits");

async function testDispatch() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status: 204 };
  };

  await dispatchGitHubWorkflow({
    token: "pat-test",
    repo: "mrvillaflor/home-value",
    workflow: "lookup.yml",
    inputs: {
      sessionId: "session-1",
      address: "100 Main St, Houston, TX 77002",
      sourceId: "homebot",
      callbackUrl: "https://home-value-api.onrender.com/callbacks",
    },
    fetchImpl,
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(
    calls[0].url,
    "https://api.github.com/repos/mrvillaflor/home-value/actions/workflows/lookup.yml/dispatches"
  );
  assert.strictEqual(calls[0].options.method, "POST");
  assert.strictEqual(calls[0].options.headers.Authorization, "Bearer pat-test");
  assert.strictEqual(calls[0].options.headers.Accept, "application/vnd.github+json");
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.ref, "main");
  assert.strictEqual(body.inputs.sourceId, "homebot");
  assert.strictEqual(body.inputs.sessionId, "session-1");
  assert.strictEqual(body.inputs.callbackUrl, "https://home-value-api.onrender.com/callbacks");
  assert.ok(body.inputs.address.includes("Main"));

  const failing = async () => ({ status: 401 });
  await assert.rejects(
    () =>
      dispatchGitHubWorkflow({
        token: "pat-test",
        repo: "mrvillaflor/home-value",
        workflow: "lookup.yml",
        inputs: { sessionId: "x", address: "x", sourceId: "homebot", callbackUrl: "https://example.com/callbacks" },
        fetchImpl: failing,
      }),
    (error) => error.status === 401 && !String(error.message).includes("Main")
  );
}

function testLimits() {
  let clock = Date.parse("2026-10-30T12:00:00.000Z");
  const limiter = createLimiter({
    windowMs: 10 * 60 * 1000,
    perIp: 5,
    dailyCap: 7,
    now: () => clock,
  });

  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(limiter.check("1.2.3.4").ok, true);
  }
  assert.strictEqual(limiter.check("1.2.3.4").reason, "ip");
  assert.strictEqual(limiter.check("5.6.7.8").ok, true);
  assert.strictEqual(limiter.check("9.9.9.9").ok, true);
  assert.strictEqual(limiter.check("8.8.8.8").reason, "daily");

  clock += 11 * 60 * 1000;
  const nextDay = createLimiter({
    windowMs: 10 * 60 * 1000,
    perIp: 5,
    dailyCap: 100,
    now: () => Date.parse("2026-10-31T00:10:00.000Z"),
  });
  assert.strictEqual(nextDay.check("1.2.3.4").ok, true);
}

(async () => {
  await testDispatch();
  testLimits();
  process.stdout.write("dispatch and limit tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
