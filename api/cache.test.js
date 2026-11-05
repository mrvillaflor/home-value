const assert = require("assert");
const { cacheKey } = require("./address");
const workerAddress = require("../worker/address");
const { createStore, freshMap, remember, isSuccess, TTL_MS } = require("./result-cache");

const JAYWOOD_DR = "9515 Jaywood Dr, Houston, TX 77040";
const JAYWOOD_DRIVE = "9515 Jaywood Drive Houston TX 77040";

function done(value, fetchedAt) {
  return {
    status: "done",
    value,
    low: value - 10000,
    high: value + 10000,
    fetchedAt: fetchedAt || new Date(0).toISOString(),
    error: null,
  };
}

function testKeys() {
  assert.strictEqual(cacheKey(JAYWOOD_DR), cacheKey(JAYWOOD_DRIVE));
  assert.strictEqual(cacheKey(JAYWOOD_DR), workerAddress.cacheKey(JAYWOOD_DRIVE));
  assert.strictEqual(cacheKey(JAYWOOD_DR), "9515 jaywood dr, houston, tx 77040");
  assert.notStrictEqual(
    cacheKey("3505 Sage Rd Apt 1810, Houston, TX 77056"),
    cacheKey("3505 Sage Rd, Houston, TX 77056")
  );
  assert.strictEqual(cacheKey(""), "");
}

function testSuccessShape() {
  assert.strictEqual(isSuccess(done(250000)), true);
  assert.strictEqual(isSuccess(done(10000)), true);
  assert.strictEqual(isSuccess(done(100000000)), true);
  assert.strictEqual(isSuccess(done(9999)), false);
  assert.strictEqual(isSuccess({ status: "done", value: null }), false);
  assert.strictEqual(isSuccess({ status: "unavailable", value: null, error: "blocked" }), false);
  assert.strictEqual(isSuccess({ status: "done", value: "250000" }), false);
}

function testTtlAndPerSource() {
  const store = createStore();
  const key = cacheKey(JAYWOOD_DRIVE);
  let now = 0;
  assert.strictEqual(remember(store, key, "rate", done(310000), now, TTL_MS), true);
  assert.strictEqual(remember(store, key, "har", { status: "unavailable", value: null, error: "HAR.com blocked the address search." }, now, TTL_MS), false);
  assert.strictEqual(remember(store, key, "chase", { status: "done", value: null }, now, TTL_MS), false);

  let fresh = freshMap(store, key, now, TTL_MS);
  assert.strictEqual(fresh.rate.value, 310000);
  assert.strictEqual(fresh.har, undefined);
  assert.strictEqual(fresh.chase, undefined);
  fresh.rate.value = 1;
  assert.strictEqual(freshMap(store, key, now, TTL_MS).rate.value, 310000);

  now = 20 * 60 * 60 * 1000;
  assert.strictEqual(remember(store, key, "homebot", done(280000, new Date(now).toISOString()), now, TTL_MS), true);

  now = TTL_MS;
  fresh = freshMap(store, key, now, TTL_MS);
  assert.strictEqual(fresh.rate, undefined);
  assert.strictEqual(fresh.homebot.value, 280000);

  now = 20 * 60 * 60 * 1000 + TTL_MS;
  fresh = freshMap(store, key, now, TTL_MS);
  assert.deepStrictEqual(fresh, {});
  assert.strictEqual(store.entries[key], undefined);
}

function testOtherAddress() {
  const store = createStore();
  remember(store, cacheKey(JAYWOOD_DR), "rate", done(310000), 0, TTL_MS);
  const other = freshMap(store, cacheKey("5539 Darling St, Houston, TX 77007"), 0, TTL_MS);
  assert.deepStrictEqual(other, {});
}

testKeys();
testSuccessShape();
testTtlAndPerSource();
testOtherAddress();
process.stdout.write("cache tests passed\n");
