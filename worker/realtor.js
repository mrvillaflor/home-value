/*
 * Realtor.com lookup without the homepage search.
 *
 * The public suggest service resolves the address. The top result is used
 * only when its street number and ZIP match. The property page is then
 * read for the estimate marked isbest_homevalue. A block is Unavailable.
 * No claim-home, signup, or login.
 */

const SUGGEST_URL = "https://parser-external.geo.moveaws.com/suggest";
const BLOCK_RE = /access denied|press\s*&\s*hold|verify you are human|are you a robot|request blocked|kasada|kpsdk|too many requests/i;

function outcome(status, extra) {
  return {
    sourceId: "realtor",
    status,
    value: extra.value ?? null,
    low: extra.low ?? null,
    high: extra.high ?? null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

function money(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) return null;
  return value;
}

function streetNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? match[0] : "";
}

function zipCode(value) {
  const match = String(value || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : "";
}

function topSuggestionMatches(address, payload) {
  const rows = payload && Array.isArray(payload.autocomplete) ? payload.autocomplete : [];
  const top = rows[0];
  if (!top) return null;
  const askedNumber = streetNumber(address);
  const askedZip = zipCode(address);
  const id = String(top.mpr_id || "");
  if (!/^\d+$/.test(id)) return null;
  if (!askedNumber || !askedZip) return null;
  if (streetNumber(top.line) !== askedNumber) return null;
  if (String(top.postal_code || "") !== askedZip) return null;
  return top;
}

function bestEstimate(body) {
  const raw = String(body || "");
  const flags = ['"isbest_homevalue":true', '"isbest_homevalue": true', '\\"isbest_homevalue\\":true'];
  let index = -1;
  for (const flag of flags) {
    const found = raw.indexOf(flag);
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) return null;
  const windowText = raw.slice(Math.max(0, index - 500), index + 250);
  const plain = windowText.match(/"estimate"\s*:\s*(\d{4,9})/);
  const escaped = windowText.match(/\\"estimate\\"\s*:\s*(\d{4,9})/);
  const value = money((plain || escaped || [])[1]);
  if (value == null) return null;
  const lowMatch = windowText.match(/"estimate_low"\s*:\s*(\d{4,9})/) || windowText.match(/\\"estimate_low\\"\s*:\s*(\d{4,9})/);
  const highMatch = windowText.match(/"estimate_high"\s*:\s*(\d{4,9})/) || windowText.match(/\\"estimate_high\\"\s*:\s*(\d{4,9})/);
  const low = lowMatch ? money(lowMatch[1]) : null;
  const high = highMatch ? money(highMatch[1]) : null;
  if (low != null && high != null && low <= value && value <= high) return { value, low, high };
  return { value, low: null, high: null };
}

function parseRealtorEstimate(text) {
  const source = String(text || "");
  if (BLOCK_RE.test(source)) return { blocked: true, value: null };
  const fromJson = bestEstimate(source);
  if (fromJson) return { blocked: false, value: fromJson.value, low: fromJson.low, high: fromJson.high };
  const label = source.match(/real\s*estimate/i);
  if (!label) return { blocked: false, value: null };
  const start = Math.max(0, label.index - 48);
  const windowText = source.slice(start, label.index + label[0].length + 48);
  const nearby = [];
  const pattern = /\$\s*(\d{1,3}(?:,\d{3})+|\d{4,9})/g;
  let match;
  while ((match = pattern.exec(windowText))) {
    const value = Number(match[1].replace(/,/g, ""));
    if (value >= 10000 && value <= 100000000) {
      nearby.push({ value, distance: Math.abs(start + match.index - label.index) });
    }
  }
  if (!nearby.length) return { blocked: false, value: null };
  nearby.sort((a, b) => a.distance - b.distance);
  return { blocked: false, value: nearby[0].value, low: null, high: null };
}

async function scrapeRealtor(address, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  const askedNumber = streetNumber(address);
  let suggestion;
  try {
    const suggestUrl = new URL(SUGGEST_URL);
    suggestUrl.searchParams.set("input", address);
    suggestUrl.searchParams.set("client_id", "rdc-home");
    suggestUrl.searchParams.set("limit", "5");
    suggestUrl.searchParams.set("area_types", "address");
    const response = await fetch(suggestUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(Math.min(12000, timeoutMs)),
    });
    if (!response.ok) return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
    suggestion = topSuggestionMatches(address, await response.json());
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Realtor.com did not respond in time." });
    return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
  }
  if (!suggestion) return outcome("unavailable", { error: "Realtor.com did not show an estimate." });

  const pageUrl = "https://www.realtor.com/realestateandhomes-detail/M" + suggestion.mpr_id;
  let response;
  try {
    response = await fetch(pageUrl, {
      headers: {
        Accept: "text/html,application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Realtor.com did not respond in time." });
    return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
  }
  const body = await response.text();
  if (response.status === 429 || response.status === 403 || response.status >= 400 || BLOCK_RE.test(body.slice(0, 4000))) {
    return outcome("unavailable", { error: "Realtor.com blocked the lookup." });
  }
  if (!askedNumber || !body.includes(askedNumber)) {
    return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
  }
  const parsed = parseRealtorEstimate(body);
  if (parsed.blocked) return outcome("unavailable", { error: "Realtor.com blocked the lookup." });
  if (parsed.value == null) return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
  return outcome("done", { value: parsed.value, low: parsed.low, high: parsed.high });
}

module.exports = { scrapeRealtor, parseRealtorEstimate, topSuggestionMatches };
