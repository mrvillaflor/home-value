/*
 * Chase Home Value Estimator.
 *
 * Opens the public estimator page and searches the address in the
 * embedded value tool. It does not click Start online, preapproval,
 * or sign in. A block or a missing figure is Unavailable.
 */

const { chromium } = require("playwright");

const CHASE_URL = "https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator";
const BLOCK_RE = /access denied|press\s*&\s*hold|px-captcha|verify you are human|are you a robot|request blocked|kasada/i;

function parseChaseEstimate(text) {
  const source = String(text || "");
  if (BLOCK_RE.test(source)) return { blocked: true, value: null };
  const match = source.match(/\$\s*([\d,]{4,})\s*Estimated Value/i);
  if (!match) return { blocked: false, value: null };
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) {
    return { blocked: false, value: null };
  }
  return { blocked: false, value };
}

function outcome(status, extra) {
  return {
    sourceId: "chase",
    status,
    value: extra.value ?? null,
    low: null,
    high: null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

async function scrapeChase(address, options = {}) {
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
      viewport: { width: 1366, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page.setDefaultTimeout(Math.min(12000, timeLeft()));
    const response = await page.goto(CHASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    if (!response || response.status() >= 400) {
      return outcome("unavailable", { error: "Chase blocked the lookup." });
    }

    const frameDeadline = Date.now() + Math.min(15000, timeLeft());
    let frame = null;
    while (!frame && Date.now() < frameDeadline) {
      frame = page.frames().find((item) => /valuemap/i.test(item.url()));
      if (!frame) await page.waitForTimeout(400);
    }
    if (!frame) return outcome("unavailable", { error: "Chase did not show the estimator." });

    const box = frame.locator("#txtStreetAddress");
    const ready = await box.waitFor({ state: "visible", timeout: Math.min(12000, timeLeft()) }).then(() => true).catch(() => false);
    if (!ready) return outcome("unavailable", { error: "Chase did not show the estimator." });
    await box.fill(address);
    await frame.locator("#btnGO").click();
    await frame.waitForFunction(
      () => /\$\s*[\d,]{4,}\s*Estimated Value/i.test(document.body ? document.body.innerText : ""),
      { timeout: Math.min(20000, timeLeft()) }
    ).catch(() => {});

    const text = await frame.evaluate(() => (document.body && document.body.innerText) || "");
    if (BLOCK_RE.test(text)) return outcome("unavailable", { error: "Chase blocked the lookup." });
    const streetNumber = (address.match(/\d+/) || [""])[0];
    if (streetNumber && !text.includes(streetNumber)) {
      return outcome("unavailable", { error: "Chase did not show an estimate." });
    }
    const parsed = parseChaseEstimate(text);
    if (parsed.blocked) return outcome("unavailable", { error: "Chase blocked the lookup." });
    if (parsed.value == null) return outcome("unavailable", { error: "Chase did not show an estimate." });
    return outcome("done", { value: parsed.value });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Chase did not respond in time." });
    return outcome("unavailable", { error: "Chase did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeChase, parseChaseEstimate };
