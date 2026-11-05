/*
 * 24-hour cache of successful per-source estimates.
 * The API keeps one store in memory. The page uses the same rules
 * on a localStorage object. Failures are never stored. An entry is
 * not served once it is 24 hours old.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HomeValueCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TTL_MS = 24 * 60 * 60 * 1000;
  const MIN_VALUE = 10000;
  const MAX_VALUE = 100000000;

  function createStore() {
    return { version: 1, entries: {} };
  }

  function isSuccess(result) {
    if (!result || result.status !== "done") return false;
    if (typeof result.value !== "number" || !Number.isFinite(result.value)) return false;
    return result.value >= MIN_VALUE && result.value <= MAX_VALUE;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function storedAtFor(result, now) {
    const parsed = Date.parse(result && result.fetchedAt);
    if (!Number.isFinite(parsed)) return now;
    return Math.min(parsed, now);
  }

  function remember(store, key, sourceId, result, now, ttlMs) {
    const ttl = ttlMs || TTL_MS;
    if (!store || !key || !sourceId || !isSuccess(result)) return false;
    const storedAt = storedAtFor(result, now);
    if (now - storedAt >= ttl) return false;
    if (!store.entries || typeof store.entries !== "object") store.entries = {};
    if (!store.entries[key]) store.entries[key] = {};
    store.entries[key][sourceId] = { storedAt, result: clone(result) };
    return true;
  }

  function freshMap(store, key, now, ttlMs) {
    const ttl = ttlMs || TTL_MS;
    const out = {};
    if (!store || !store.entries || !key) return out;
    const bucket = store.entries[key];
    if (!bucket || typeof bucket !== "object") return out;
    for (const sourceId of Object.keys(bucket)) {
      const item = bucket[sourceId];
      const fresh = item
        && typeof item.storedAt === "number"
        && now - item.storedAt < ttl
        && isSuccess(item.result);
      if (!fresh) {
        delete bucket[sourceId];
        continue;
      }
      out[sourceId] = clone(item.result);
    }
    if (!Object.keys(bucket).length) delete store.entries[key];
    return out;
  }

  return {
    TTL_MS,
    createStore,
    isSuccess,
    remember,
    freshMap,
  };
});
