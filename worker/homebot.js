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

    const numberMatch = address.match(/\d+/);
    const streetNumber = numberMatch ? numberMatch[0] : "";
    const option = page.locator('[role="option"]').filter({ hasText: streetNumber || address }).first();
    const appeared = await option.waitFor({ timeout: Math.min(8000, timeLeft()) }).then(() => true).catch(() => false);
    if (!appeared) {
      return outcome("unavailable", { error: SIGNUP_ERROR });
    }

    // Choose the address suggestion. Do not touch Sign in, email, or Go.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

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
