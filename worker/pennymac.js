/*
 * PennyMac public home-value estimator.
 *
 * Types the address, chooses the suggestion, and lets the reCAPTCHA
 * checkbox pass on its own. An image challenge is not solved. The result
 * is then Unavailable, and the source stays wired.
 */

const { chromium } = require("playwright");

const PENNYMAC_URL = "https://www.pennymac.com/home-value-estimator";
const BLOCK_RE = /access denied|request blocked|too many requests/i;

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

function parsePennyMacEstimate(text) {
  const source = String(text || "");
  const label = source.match(/estimated (?:home )?value|home value estimate|your home is worth/i);
  if (!label) return null;
  const windowText = source.slice(Math.max(0, label.index - 40), label.index + label[0].length + 60);
  const match = windowText.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d{5,9})/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) return null;
  return value;
}

async function imageChallenge(page) {
  const frames = page.frames().filter((frame) => /recaptcha\/api2\/bframe/.test(frame.url()));
  for (const frame of frames) {
    const text = await frame.evaluate(() => (document.body && document.body.innerText) || "").catch(() => "");
    if (/select all images|click verify|crosswalk|traffic lights|bicycles|challenge/i.test(text)) return true;
  }
  return false;
}

async function clickCheckbox(page) {
  const frames = page.frames().filter((frame) => /recaptcha\/api2\/anchor/.test(frame.url()));
  for (const frame of frames) {
    const checkbox = frame.locator("#recaptcha-anchor");
    if (!(await checkbox.count())) continue;
    const checked = await checkbox.getAttribute("aria-checked").catch(() => null);
    if (checked === "true") return true;
    await checkbox.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const after = await checkbox.getAttribute("aria-checked").catch(() => null);
    if (after === "true") return true;
  }
  return false;
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
    if (!response || response.status() >= 400) {
      return outcome("unavailable", { error: "PennyMac blocked the lookup." });
    }
    const box = page.locator('input[placeholder="Start Typing..."]');
    if (await box.count()) {
      await box.click();
      await box.pressSequentially(address, { delay: 30 });
      await page.waitForTimeout(Math.min(1500, timeLeft()));
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    const passed = await clickCheckbox(page);
    if (await imageChallenge(page) || !passed) {
      return outcome("unavailable", { error: "PennyMac's captcha image challenge blocked the estimate." });
    }
    const button = page.getByRole("button", { name: /Get Home Value Estimate/i });
    if (await button.count()) await button.click().catch(() => {});
    await page.waitForTimeout(Math.min(5000, timeLeft()));
    if (await imageChallenge(page)) {
      return outcome("unavailable", { error: "PennyMac's captcha image challenge blocked the estimate." });
    }
    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    if (BLOCK_RE.test(text)) return outcome("unavailable", { error: "PennyMac blocked the lookup." });
    const streetNumber = (address.match(/\d+/) || [""])[0];
    const value = parsePennyMacEstimate(text);
    if (value != null && streetNumber && text.includes(streetNumber)) return outcome("done", { value });
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
