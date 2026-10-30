/*
 * Realtor.com lookup by public address search.
 *
 * Reads a RealEstimate from the property page when it is already visible.
 * It does not claim a home, sign up, or log in. Kasada and other blocks
 * are Unavailable. There is no retry.
 */

const { chromium } = require("playwright");

const BLOCK_RE = /access denied|press\s*&\s*hold|verify you are human|are you a robot|request blocked|kasada|kpsdk|too many requests/i;
const SIGNUP_RE = /claim your home|sign up|log in to|create an account|email address/i;

function parseRealtorEstimate(text) {
  const source = String(text || "");
  if (BLOCK_RE.test(source)) return { blocked: true, value: null };
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
  return { blocked: false, value: nearby[0].value };
}

function outcome(status, extra) {
  return {
    sourceId: "realtor",
    status,
    value: extra.value ?? null,
    low: null,
    high: null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

async function scrapeRealtor(address, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 40000);
  const timeLeft = () => Math.max(500, deadline - Date.now());
  const launch = {
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
  };
  if (options.chromePath) launch.executablePath = options.chromePath;

  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page.setDefaultTimeout(Math.min(12000, timeLeft()));
    const response = await page.goto("https://www.realtor.com/", {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    const status = response ? response.status() : 0;
    const title = await page.title();
    const intro = await page.evaluate(() => (document.body && document.body.innerText) || "");
    if (status === 429 || status >= 400 || BLOCK_RE.test(title + "\n" + intro)) {
      return outcome("unavailable", { error: "Realtor.com blocked the lookup." });
    }

    const box = page.locator('input[placeholder*="Address" i], input[placeholder*="City" i], input[aria-label*="Search" i]').first();
    if (!(await box.count())) {
      if (SIGNUP_RE.test(intro)) return outcome("unavailable", { error: "Realtor.com requires a signup to show the estimate." });
      return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
    }
    await box.click();
    await box.fill("");
    await box.pressSequentially(address, { delay: 25 });
    const streetNumber = (address.match(/\d+/) || [""])[0];
    const option = page.locator('[role="option"]').filter({ hasText: streetNumber || address }).first();
    const appeared = await option.waitFor({ timeout: Math.min(8000, timeLeft()) }).then(() => true).catch(() => false);
    if (!appeared) return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
    await option.click();
    await page.waitForTimeout(Math.min(4000, timeLeft()));

    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    if (BLOCK_RE.test(await page.title() + "\n" + text)) {
      return outcome("unavailable", { error: "Realtor.com blocked the lookup." });
    }
    if (SIGNUP_RE.test(text) && !/real\s*estimate/i.test(text)) {
      return outcome("unavailable", { error: "Realtor.com requires a signup to show the estimate." });
    }
    const parsed = parseRealtorEstimate(text);
    if (parsed.blocked) return outcome("unavailable", { error: "Realtor.com blocked the lookup." });
    if (parsed.value == null || (streetNumber && !text.includes(streetNumber))) {
      return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
    }
    return outcome("done", { value: parsed.value });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Realtor.com did not respond in time." });
    return outcome("unavailable", { error: "Realtor.com did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeRealtor, parseRealtorEstimate };
