const assert = require("assert");
const { pickProfile, blockKind, blockError, shouldRetryOutcome, withOneRetry, PROFILES } = require("./harden");

function testProfiles() {
  const seen = new Set();
  for (let attempt = 0; attempt < PROFILES.length; attempt += 1) {
    const profile = pickProfile(attempt);
    assert.ok(PROFILES.includes(profile));
    assert.match(profile.userAgent, /Chrome\/\d+/);
    assert.ok(!/Headless|bot/i.test(profile.userAgent));
    assert.strictEqual(typeof profile.viewport.width, "number");
    assert.strictEqual(typeof profile.viewport.height, "number");
    assert.strictEqual(profile.locale, "en-US");
    assert.match(profile.timezoneId, /^America\//);
    assert.match(profile.acceptLanguage, /^en-US/);
    seen.add(profile.userAgent + profile.viewport.width + profile.timezoneId);
  }
  assert.ok(seen.size >= 2);
}

function testBlockDetection() {
  assert.strictEqual(blockKind(429, ""), "rate-limited");
  assert.strictEqual(blockKind(403, ""), "blocked");
  assert.strictEqual(blockKind(200, "please verify you are a human"), "blocked");
  assert.strictEqual(blockKind(200, "<div id=\"px-captcha\"></div>"), "blocked");
  assert.strictEqual(blockKind(200, "Errors.edgesuite.net reference"), "blocked");
  assert.strictEqual(blockKind(200, "Homebot estimate $250,000"), "");
  assert.strictEqual(blockKind(200, ""), "");
  assert.strictEqual(blockError("Chase", 429, ""), "Chase rate-limited the lookup.");
  assert.strictEqual(blockError("HAR.com", 403, ""), "HAR.com blocked the lookup.");
  assert.strictEqual(blockError("Rate.com", 200, "estimated value $10"), "");
}

function testRetryOutcome() {
  assert.strictEqual(shouldRetryOutcome({ status: "unavailable", error: "Chase blocked the lookup." }), true);
  assert.strictEqual(shouldRetryOutcome({ status: "unavailable", error: "HAR.com rate-limited the lookup." }), true);
  assert.strictEqual(shouldRetryOutcome({ status: "unavailable", error: "HAR.com blocked the address search." }), true);
  assert.strictEqual(shouldRetryOutcome({ status: "unavailable", error: "HAR.com blocked the property page." }), true);
  assert.strictEqual(shouldRetryOutcome({ status: "unavailable", error: "Homebot did not show an estimate." }), false);
  assert.strictEqual(shouldRetryOutcome({ status: "done", value: 250000, error: null }), false);
}

async function testOneRetry() {
  const deadline = Date.now() + 60000;
  let calls = 0;
  const once = await withOneRetry(deadline, async () => {
    calls += 1;
    return { status: "unavailable", error: "Homebot did not show an estimate." };
  }, 0);
  assert.strictEqual(calls, 1);
  assert.strictEqual(once.error, "Homebot did not show an estimate.");

  calls = 0;
  const retried = await withOneRetry(deadline, async (attempt) => {
    calls += 1;
    if (attempt === 0) return { status: "unavailable", error: "Chase blocked the lookup." };
    return { status: "done", value: 250000, error: null };
  }, 0);
  assert.strictEqual(calls, 2);
  assert.strictEqual(retried.status, "done");
  assert.strictEqual(retried.value, 250000);

  calls = 0;
  const expired = await withOneRetry(Date.now() + 1000, async () => {
    calls += 1;
    return { status: "unavailable", error: "Chase blocked the lookup." };
  }, 0);
  assert.strictEqual(calls, 1);
  assert.match(expired.error, /blocked/);
}

(async () => {
  testProfiles();
  testBlockDetection();
  testRetryOutcome();
  await testOneRetry();
  process.stdout.write("harden tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
