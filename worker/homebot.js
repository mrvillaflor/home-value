/*
 * Homebot lookup through Matthew Villaflor's public agent link.
 *
 * Opens the link, chooses an address from the autocomplete, and reads a
 * labeled estimate only if it is already on the screen. It never types an
 * email, name, phone, or password, and it never clicks sign up, continue,
 * a magic link, Get rate, Send, or Go.
 */

const { chromium } = require("playwright");

const HOMEBOT_URL = "https://get.homebot.ai/?id=d349faa6-b63a-427c-874f-13ead9609b31";
const SIGNUP_ERROR = "Homebot requires a signup to show the estimate.";

function parseHomebotEstimate(text) {
  const source = String(text || "");
  const label = source.match(/the estimated value of your home is/i);
  if (!label) return null;
  const after = source.slice(label.index, label.index + label[0].length + 48);
  const match = after.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d{4,9})/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) return null;
  return value;
}

function asksForSignup(text) {
  return /email address|sign in with email|sign up|magic link|create a password|continue with email|unlock your free report/i.test(String(text || ""));
}

function outcome(status, extra) {
  return {
    sourceId: "homebot",
    status,
    value: extra.value ?? null,
    low: extra.low ?? null,
    high: extra.high ?? null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
  };
}

async function scrapeHomebot(address, options = {}) {
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
    page.setDefaultTimeout(Math.min(12000, timeLeft()));

    const response = await page.goto(HOMEBOT_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(20000, timeLeft()),
    });
    if (!response || response.status() >= 400) {
      return outcome("unavailable", { error: "Homebot did not load." });
    }

    const box = page.locator('input[placeholder="Add your street address..."]');
    if (!(await box.count())) {
      return outcome("unavailable", { error: "Homebot's address field was not on the page." });
    }
    await box.click({ timeout: 5000 });
    await box.pressSequentially(address, { delay: 25 });

    const streetNumber = (address.match(/\d+/) || [""])[0];
    const zip = (address.match(/\b(\d{5})\b/) || [])[1] || "";
    const unit = (address.match(/\b(?:unit|apt|apartment|suite|ste|#)\s*[A-Za-z0-9-]+\b/i) || [""])[0];
    const options = page.locator('[role="option"]');
    const appeared = await options.first().waitFor({ timeout: Math.min(8000, timeLeft()) }).then(() => true).catch(() => false);
    if (!appeared) {
      const mainText = await page.evaluate(() => (document.body && document.body.innerText) || "");
      if (asksForSignup(mainText)) return outcome("unavailable", { error: SIGNUP_ERROR });
      return outcome("unavailable", { error: "Homebot did not show an estimate." });
    }

    // Click the suggestion that has this street number and ZIP.
    // ArrowDown would accept whatever is first, including a different house.
    let picked = false;
    const count = Math.min(await options.count(), 8);
    for (let i = 0; i < count; i += 1) {
      const text = ((await options.nth(i).innerText()) || "").replace(/\s+/g, " ");
      const numberOk = streetNumber && new RegExp("(?:^|\\D)" + streetNumber + "(?:\\D|$)").test(text);
      const unitOk = !unit || text.toLowerCase().includes(unit.toLowerCase());
      if (numberOk && zip && text.includes(zip) && unitOk) {
        await options.nth(i).click({ timeout: 5000 });
        picked = true;
        break;
      }
    }
    if (!picked) {
      const mainText = await page.evaluate(() => (document.body && document.body.innerText) || "");
      if (asksForSignup(mainText)) return outcome("unavailable", { error: SIGNUP_ERROR });
      return outcome("unavailable", { error: "Homebot did not show an estimate." });
    }

    const frameHandle = await page.waitForSelector('iframe[src*="preview/home"]', {
      timeout: Math.min(12000, timeLeft()),
    }).catch(() => null);
    if (!frameHandle) {
      const mainText = await page.evaluate(() => (document.body && document.body.innerText) || "");
      if (asksForSignup(mainText)) return outcome("unavailable", { error: SIGNUP_ERROR });
      return outcome("unavailable", { error: "Homebot did not show an estimate." });
    }

    const frame = await frameHandle.contentFrame();
    if (!frame) return outcome("unavailable", { error: "Homebot did not show an estimate." });
    await frame.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(Math.min(2500, timeLeft()));
    const text = await frame.evaluate(() => (document.body && document.body.innerText) || "");

    const value = parseHomebotEstimate(text);
    const mentionsAddress = streetNumber && text.includes(streetNumber);
    if (value != null && mentionsAddress) {
      return outcome("done", { value });
    }
    if (asksForSignup(text) || asksForSignup(await page.evaluate(() => (document.body && document.body.innerText) || ""))) {
      return outcome("unavailable", { error: SIGNUP_ERROR });
    }
    return outcome("unavailable", { error: "Homebot did not show an estimate." });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) {
      return outcome("unavailable", { error: "Homebot did not respond in time." });
    }
    return outcome("unavailable", { error: "Homebot did not show an estimate." });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeHomebot, parseHomebotEstimate, SIGNUP_ERROR };
