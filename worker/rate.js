/*
 * Rate.com public home-value lookup.
 * The address field on the page stays disabled until Google Places
 * attaches, and typing into it drops characters. When the address has a
 * street, city, state, and ZIP, ask the public valuation endpoint instead.
 * The browser is only the fallback. No refinance, equity, or pre-approval.
 */

const { chromium } = require("playwright");
const { parseLoose } = require("./address");
const { browserHeaders, blockKind, blockError, backoff, shouldRetry, openPage, withOneRetry } = require("./harden");

const RATE_PAGE = "https://www.rate.com/home-valuation";
const RATE_API = "https://www.rate.com/api/home-valuation";

function money(raw) {
  const value = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) return null;
  return value;
}

function outcome(status, extra) {
  return {
    sourceId: "rate",
    status,
    value: extra.value ?? null,
    low: extra.low ?? null,
    high: extra.high ?? null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

function splitUsAddress(address) {
  const parts = parseLoose(address);
  if (!parts) return null;
  return {
    street: parts.street,
    city: parts.city,
    state: parts.state,
    zip: parts.zip,
  };
}

function sameHouse(parts, property) {
  const askedNumber = (parts.street.match(/\d+/) || [""])[0];
  const gotNumber = (String(property.address || "").match(/\d+/) || [""])[0];
  const gotZip = String(property.cityStateZip || "");
  return Boolean(askedNumber) && askedNumber === gotNumber && gotZip.includes(parts.zip);
}

function rangeAround(value, low, high) {
  const lowValue = money(low);
  const highValue = money(high);
  if (lowValue != null && highValue != null && lowValue <= value && value <= highValue) {
    return { low: lowValue, high: highValue };
  }
  return { low: null, high: null };
}

function parseRateEstimate(text) {
  const source = String(text || "");
  const rangeMatch = source.match(/\$\s*([\d,]{4,})\s*[–-]\s*\$\s*([\d,]{4,})/);
  const low = rangeMatch ? money(rangeMatch[1]) : null;
  const high = rangeMatch ? money(rangeMatch[2]) : null;
  const label = source.match(/home value estimate|estimated (?:home )?value|your home is worth/i);
  if (!label) return null;
  const start = Math.max(0, label.index - 80);
  const windowText = source.slice(start, label.index + label[0].length + 140);
  const match = windowText.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d{5,9})/);
  const value = match ? money(match[1]) : null;
  if (value == null) return null;
  if (low != null && high != null && low <= value && value <= high) return { value, low, high };
  return { value, low: null, high: null };
}

async function lookupRateApi(address, deadline) {
  const parts = splitUsAddress(address);
  if (!parts) return null;
  const url = new URL(RATE_API);
  url.searchParams.set("street", parts.street);
  url.searchParams.set("city", parts.city);
  url.searchParams.set("state", parts.state);
  url.searchParams.set("zip", parts.zip);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: browserHeaders(attempt, "application/json"),
        signal: AbortSignal.timeout(Math.min(15000, Math.max(1000, deadline - Date.now()))),
      });
    } catch (error) {
      return null;
    }
    const kind = blockKind(response.status, "");
    if (kind) {
      if (attempt === 0 && shouldRetry(deadline, 8000)) {
        await backoff(deadline);
        continue;
      }
      return null;
    }
    if (!response.ok) return null;
    let data;
    try {
      data = await response.json();
    } catch (error) {
      return null;
    }
    const property = data && data.propertyData;
    if (!property || !sameHouse(parts, property)) return null;
    const value = money(property.estimatedValue);
    if (value == null) {
      return outcome("unavailable", { error: "Rate.com did not show an estimate." });
    }
    const range = rangeAround(value, property.estimateLow, property.estimateHigh);
    return outcome("done", { value, low: range.low, high: range.high });
  }
  return null;
}

async function scrapeRateBrowser(address, options, deadline, attempt) {
  const timeLeft = () => Math.max(500, deadline - Date.now());
  const launch = {
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
  };
  if (options.chromePath) launch.executablePath = options.chromePath;
  const browser = await chromium.launch(launch);
  try {
    const { page } = await openPage(browser, attempt);
    const response = await page.goto(RATE_PAGE, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    const status = response ? response.status() : 0;
    const title = await page.title().catch(() => "");
    const snippet = await page.evaluate(() => ((document.body && document.body.innerText) || "").slice(0, 2000)).catch(() => "");
    const blocked = blockError("Rate.com", status, title + "\n" + snippet);
    if (blocked) return outcome("unavailable", { error: blocked });
    if (!response || status >= 400) return outcome("unavailable", { error: "Rate.com did not load." });
    const box = page.locator("#address");
    if (!(await box.count())) return outcome("unavailable", { error: "Rate.com did not show an estimate." });
    const ready = await page.waitForFunction(() => {
      const field = document.querySelector("#address");
      return Boolean(field && !field.disabled && window.google && window.google.maps && window.google.maps.places);
    }, null, { timeout: Math.min(15000, timeLeft()) }).then(() => true).catch(() => false);
    if (!ready) return outcome("unavailable", { error: "Rate.com did not show an estimate." });
    await box.click();
    await page.keyboard.insertText(address);
    const streetNumber = (address.match(/\d+/) || [""])[0];
    const suggestion = page.locator(".pac-item").filter({ hasText: streetNumber || address }).first();
    const appeared = await suggestion.waitFor({ timeout: Math.min(8000, timeLeft()) }).then(() => true).catch(() => false);
    if (!appeared) return outcome("unavailable", { error: "Rate.com did not show an estimate." });
    await suggestion.click();
    const search = page.getByRole("button", { name: "Search home value" });
    if (await search.count()) await search.click().catch(() => {});
    await page.waitForFunction(() => {
      const text = (document.body && document.body.innerText) || "";
      return location.pathname.indexOf("/results") !== -1 || /home value estimate/i.test(text);
    }, null, { timeout: Math.min(12000, timeLeft()) }).catch(() => {});
    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    const pageBlocked = blockError("Rate.com", 0, text);
    if (pageBlocked) return outcome("unavailable", { error: pageBlocked });
    const parsed = parseRateEstimate(text);
    if (parsed && parsed.value != null && streetNumber && text.includes(streetNumber)) {
      return outcome("done", parsed);
    }
    return outcome("unavailable", { error: "Rate.com did not show an estimate." });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Rate.com did not respond in time." });
    return outcome("unavailable", { error: "Rate.com did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function scrapeRate(address, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 40000);
  const direct = await lookupRateApi(address, deadline);
  if (direct) return direct;
  if (deadline - Date.now() < 5000) {
    return outcome("unavailable", { error: "Rate.com did not respond in time." });
  }
  return withOneRetry(deadline, (attempt) => scrapeRateBrowser(address, options, deadline, attempt));
}

module.exports = { scrapeRate, splitUsAddress };
