/*
 * Homes.com public home-value page.
 * An access block is Unavailable. No signup and no guessed number.
 */

const { chromium } = require("playwright");

const HOMES_URL = "https://www.homes.com/how-much-is-my-home-worth/";
const BLOCK_RE = /access denied|don't have permission|edgesuite|verify you are human|captcha|request blocked|kasada/i;

function outcome(status, extra) {
  return {
    sourceId: "homes",
    status,
    value: extra.value ?? null,
    low: null,
    high: null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

function parseHomesEstimate(text) {
  const source = String(text || "");
  const label = source.match(/home valuation|estimated value|avm/i);
  if (!label) return null;
  const windowText = source.slice(label.index, label.index + 80);
  const match = windowText.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d{5,9})/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) return null;
  return value;
}

async function scrapeHomes(address, options = {}) {
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
    const response = await page.goto(HOMES_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    const status = response ? response.status() : 0;
    const title = await page.title();
    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    if (status === 403 || status === 429 || status >= 400 || BLOCK_RE.test(title + "\n" + text)) {
      return outcome("unavailable", { error: "Homes.com blocked the lookup." });
    }
    const streetNumber = (address.match(/\d+/) || [""])[0];
    const value = parseHomesEstimate(text);
    if (value != null && streetNumber && text.includes(streetNumber)) return outcome("done", { value });
    return outcome("unavailable", { error: "Homes.com did not show an estimate." });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Homes.com did not respond in time." });
    return outcome("unavailable", { error: "Homes.com did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeHomes };
