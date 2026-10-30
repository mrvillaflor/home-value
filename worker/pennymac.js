/*
 * PennyMac public home-value estimator.
 * The page asks for a captcha before it will show a value. This scraper
 * does not solve that captcha. If the captcha is present, the result is
 * Unavailable.
 */

const { chromium } = require("playwright");

const PENNYMAC_URL = "https://www.pennymac.com/home-value-estimator";
const BLOCK_RE = /access denied|verify you are human|request blocked|too many requests/i;

function outcome(status, extra) {
  return {
    sourceId: "pennymac",
    status,
    value: extra.value ?? null,
    low: null,
    high: null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

async function scrapePennyMac(address, options = {}) {
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
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const response = await page.goto(PENNYMAC_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    const status = response ? response.status() : 0;
    await page.waitForTimeout(Math.min(2000, timeLeft()));
    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    const captcha = await page.locator('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]').count();
    if (captcha > 0 || /i'm not a robot|recaptcha/i.test(text)) {
      return outcome("unavailable", { error: "PennyMac requires a captcha before it shows an estimate." });
    }
    if (status >= 400 || BLOCK_RE.test(text)) {
      return outcome("unavailable", { error: "PennyMac blocked the lookup." });
    }
    void address;
    return outcome("unavailable", { error: "PennyMac did not show an estimate." });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "PennyMac did not respond in time." });
    return outcome("unavailable", { error: "PennyMac did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapePennyMac };
