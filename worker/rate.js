/*
 * Rate.com public home-value form.
 * Searches the address only. Does not open refinance, equity, or
 * pre-approval. No value means Unavailable.
 */

const { chromium } = require("playwright");

const RATE_URL = "https://www.rate.com/home-valuation";
const BLOCK_RE = /access denied|verify you are human|captcha|request blocked|too many requests/i;
const LEAD_RE = /email address|phone number|get pre-approved|start a refinance/i;

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

function parseRateEstimate(text) {
  const source = String(text || "");
  const rangeMatch = source.match(/\$\s*([\d,]{4,})\s*[–-]\s*\$\s*([\d,]{4,})/);
  const low = rangeMatch ? money(rangeMatch[1]) : null;
  const high = rangeMatch ? money(rangeMatch[2]) : null;
  const label = source.match(/estimated (?:home )?value|your home is worth/i);
  if (!label) return null;
  const start = Math.max(0, label.index - 60);
  const windowText = source.slice(start, label.index + label[0].length + 80);
  const match = windowText.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d{5,9})/);
  const value = match ? money(match[1]) : null;
  if (value == null) return null;
  if (low != null && high != null && low <= value && value <= high) return { value, low, high };
  return { value, low: null, high: null };
}

async function scrapeRate(address, options = {}) {
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
    const response = await page.goto(RATE_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    if (!response || response.status() >= 400) return outcome("unavailable", { error: "Rate.com blocked the lookup." });
    const box = page.locator("#address");
    if (!(await box.count())) return outcome("unavailable", { error: "Rate.com did not show an estimate." });
    await box.scrollIntoViewIfNeeded();
    await box.click();
    await box.fill("");
    await box.pressSequentially(address, { delay: 40 });
    const streetNumber = (address.match(/\d+/) || [""])[0];
    await page.waitForTimeout(Math.min(1500, timeLeft()));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const search = page.getByRole("button", { name: "Search home value" });
    if (await search.count()) await search.click().catch(() => {});
    await page.waitForTimeout(Math.min(5000, timeLeft()));
    const skip = page.getByRole("button", { name: /no thanks|not now|skip|maybe later/i });
    if (await skip.count()) await skip.first().click().catch(() => {});
    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    if (BLOCK_RE.test(text)) return outcome("unavailable", { error: "Rate.com blocked the lookup." });
    const parsed = parseRateEstimate(text);
    if (parsed && parsed.value != null && streetNumber && text.includes(streetNumber)) {
      return outcome("done", parsed);
    }
    if (LEAD_RE.test(text)) return outcome("unavailable", { error: "Rate.com did not show an estimate." });
    return outcome("unavailable", { error: "Rate.com did not show an estimate." });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "Rate.com did not respond in time." });
    return outcome("unavailable", { error: "Rate.com did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeRate };
