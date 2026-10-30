/*
 * Redfin lookup through the public site only.
 *
 * Opens redfin.com, uses the My Home Value address field, and reads a
 * Redfin Estimate from the page that follows. It does not sign in, does
 * not submit a lead form, and does not try to solve a captcha. A block
 * or captcha becomes status "unavailable".
 */

const { chromium } = require("playwright");

const BLOCK_RE = /press\s*&\s*hold|access to this page has been denied|px-captcha|verify you are a human|are you a robot|403 error|request blocked|the request could not be satisfied/i;
const LEAD_RE = /email address|phone number|your name|create an account|sign up to see/i;

function moneyNumbers(text) {
  return [...String(text).matchAll(/\$\s*(\d{1,3}(?:,\d{3})+|\d{4,9})(?:\.\d+)?/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 10000 && value <= 100000000);
}

function parseRedfinEstimate(text) {
  const source = String(text || "");
  if (BLOCK_RE.test(source)) return { blocked: true, value: null, low: null, high: null };
  const label = source.match(/redfin estimate/i);
  if (!label) return { blocked: false, value: null, low: null, high: null };
  const at = label.index;
  const start = Math.max(0, at - 40);
  const end = Math.min(source.length, at + label[0].length + 80);
  const windowText = source.slice(start, end);
  const nearby = [];
  const pattern = /\$\s*(\d{1,3}(?:,\d{3})+|\d{4,9})(?:\.\d+)?/g;
  let match;
  while ((match = pattern.exec(windowText))) {
    const value = Number(match[1].replace(/,/g, ""));
    if (value >= 10000 && value <= 100000000) {
      nearby.push({ value, distance: Math.abs(start + match.index - at) });
    }
  }
  if (!nearby.length) return { blocked: false, value: null, low: null, high: null };
  nearby.sort((a, b) => a.distance - b.distance);
  const value = nearby[0].value;
  const after = moneyNumbers(source.slice(at + label[0].length, at + label[0].length + 80)).filter((item) => item !== value);
  let low = null;
  let high = null;
  if (after.length >= 2) {
    low = Math.min(after[0], after[1]);
    high = Math.max(after[0], after[1]);
    if (low > value || high < value) {
      low = null;
      high = null;
    }
  }
  return { blocked: false, value, low, high };
}

function result(status, extra) {
  return {
    sourceId: "redfin",
    status,
    value: extra.value ?? null,
    low: extra.low ?? null,
    high: extra.high ?? null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

async function pageText(page) {
  return page.evaluate(() => (document.body && document.body.innerText) || "");
}

async function scrapeRedfin(address, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 40000);
  const timeLeft = () => Math.max(500, deadline - Date.now());
  const launch = {
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
  };
  if (options.chromePath) launch.executablePath = options.chromePath;

  const browser = await chromium.launch(launch);
  let autocompleteBlocked = false;
  try {
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page.setDefaultTimeout(Math.min(15000, timeLeft()));
    page.on("response", (response) => {
      if (/location-autocomplete/i.test(response.url()) && response.status() >= 400) {
        autocompleteBlocked = true;
      }
    });

    const home = await page.goto("https://www.redfin.com/", {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    if (!home || home.status() >= 400 || BLOCK_RE.test(await page.title())) {
      return result("unavailable", { error: "Redfin blocked the lookup." });
    }

    const closer = page.locator("#onetrust-close-btn-container button, .onetrust-close-btn-handler").first();
    if (await closer.count()) {
      await closer.click({ timeout: 2000 }).catch(() => {});
    }

    const homeValue = page.getByText("My Home Value", { exact: true }).first();
    if (await homeValue.count()) {
      await homeValue.click({ timeout: 5000 }).catch(() => {});
    }

    let box = page.locator('input[placeholder="Enter your street address"]');
    if (!(await box.count())) {
      box = page.locator('input[placeholder="City, Address, School, Agent, ZIP"]');
    }
    if (!(await box.count())) {
      return result("unavailable", { error: "Redfin's address field was not on the page." });
    }
    await box.click({ timeout: 5000 });
    await box.fill("");
    await box.pressSequentially(address, { delay: 25 });

    const numberMatch = address.match(/\d+/);
    const streetNumber = numberMatch ? numberMatch[0] : "";
    const option = streetNumber
      ? page.locator('[role="option"]').filter({ hasText: streetNumber }).first()
      : page.locator('[role="option"]').first();
    const started = Date.now();
    while (Date.now() - started < 8000 && Date.now() < deadline) {
      if (await option.count()) break;
      if (autocompleteBlocked) break;
      await page.waitForTimeout(250);
    }

    if (autocompleteBlocked && !(await option.count())) {
      return result("unavailable", { error: "Redfin blocked the address search." });
    }

    if (await option.count()) {
      await option.click({ timeout: 5000 });
    } else {
      await box.press("Enter");
    }

    await page.waitForTimeout(Math.min(4000, timeLeft()));
    const text = await pageText(page);
    const title = await page.title();
    if (BLOCK_RE.test(title + "\n" + text)) {
      return result("unavailable", { error: "Redfin blocked the lookup." });
    }
    if (LEAD_RE.test(text) && !/redfin estimate/i.test(text)) {
      return result("unavailable", { error: "Redfin asked for contact information, so no estimate was requested." });
    }

    const parsed = parseRedfinEstimate(text);
    if (parsed.blocked) {
      return result("unavailable", { error: "Redfin blocked the lookup." });
    }
    if (parsed.value == null) {
      return result("unavailable", { error: "Redfin did not show an estimate." });
    }
    return result("done", { value: parsed.value, low: parsed.low, high: parsed.high });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) {
      return result("unavailable", { error: "Redfin did not respond in time." });
    }
    return result("unavailable", { error: "Redfin did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeRedfin, parseRedfinEstimate };
