/*
 * In-memory abuse limits. They reset when the process restarts, which
 * includes a Render free instance waking from sleep.
 */

function createLimiter({
  windowMs = 10 * 60 * 1000,
  perIp = 5,
  dailyCap = 100,
  now = () => Date.now(),
} = {}) {
  const hits = new Map();
  let day = "";
  let count = 0;

  return {
    check(ip) {
      const currentDay = new Date(now()).toISOString().slice(0, 10);
      if (currentDay !== day) {
        day = currentDay;
        count = 0;
      }
      if (count >= dailyCap) {
        return { ok: false, reason: "daily" };
      }
      const recent = (hits.get(ip) || []).filter((stamp) => now() - stamp < windowMs);
      if (recent.length >= perIp) {
        hits.set(ip, recent);
        return { ok: false, reason: "ip" };
      }
      recent.push(now());
      hits.set(ip, recent);
      count += 1;
      return { ok: true };
    },
  };
}

module.exports = { createLimiter };
