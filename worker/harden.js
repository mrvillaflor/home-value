/*
 * Vary a few browser traits per run, and retry once when a site
 * rate-limits or blocks the lookup. The retry stays inside one source
 * so the others, which already run in parallel, are not held up.
 */

const PROFILES = [
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    viewport: { width: 1536, height: 864 },
    locale: "en-US",
    timezoneId: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Denver",
    acceptLanguage: "en-US,en;q=0.8",
  },
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    acceptLanguage: "en-US,en;q=0.9",
  },
];

const BLOCK_RE = /px-captcha|perimeterx|kasada|access to this page has been denied|\baccess denied\b|press\s*&\s*hold|verify you are (?:a )?human|are you a robot|errors\.edgesuite\.net|request blocked|attention required|cf-browser-verification|just a moment\.\.\.|captcha-delivery|datadome|pardon our interruption/i;

function pickProfile(attempt) {
  const start = Math.floor(Math.random() * PROFILES.length);
  const index = (start + (Number(attempt) || 0)) % PROFILES.length;
  return PROFILES[index];
}

function blockKind(status, text) {
  if (status === 429) return "rate-limited";
  const sample = String(text || "").slice(0, 8000);
  if (/too many requests|rate limit/i.test(sample)) return "rate-limited";
  if (status === 403) return "blocked";
  if (BLOCK_RE.test(sample)) return "blocked";
  return "";
}

function blockError(site, status, text) {
  const kind = blockKind(status, text);
  if (kind === "rate-limited") return site + " rate-limited the lookup.";
  if (kind === "blocked") return site + " blocked the lookup.";
  return "";
}

function browserHeaders(attempt, accept) {
  const profile = pickProfile(attempt);
  return {
    "User-Agent": profile.userAgent,
    Accept: accept,
    "Accept-Language": profile.acceptLanguage,
  };
}

function shouldRetryOutcome(result) {
  if (!result || result.status !== "unavailable") return false;
  return /blocked the lookup\.|rate-limited the lookup\.|blocked the address search\.|blocked the property page\./.test(String(result.error || ""));
}

function shouldRetry(deadline, minLeftMs) {
  const minLeft = minLeftMs == null ? 12000 : minLeftMs;
  return deadline - Date.now() > minLeft;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function backoff(deadline, pauseOverride) {
  const pauseMs = typeof pauseOverride === "number"
    ? pauseOverride
    : 800 + Math.floor(Math.random() * 1200);
  if (deadline && Date.now() + pauseMs > deadline - 8000) return false;
  if (pauseMs > 0) await sleep(pauseMs);
  return true;
}

function unpack(value) {
  if (value && Object.prototype.hasOwnProperty.call(value, "retryable") && value.result) {
    return value;
  }
  return { retryable: shouldRetryOutcome(value), result: value };
}

async function withOneRetry(deadline, attemptFn, pauseOverride) {
  const first = unpack(await attemptFn(0));
  if (!first.retryable || !shouldRetry(deadline)) return first.result;
  const paused = await backoff(deadline, pauseOverride);
  if (!paused) return first.result;
  const second = unpack(await attemptFn(1));
  return second.result;
}

async function openPage(browser, attempt) {
  const profile = pickProfile(attempt);
  const context = await browser.newContext({
    userAgent: profile.userAgent,
    viewport: profile.viewport,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    extraHTTPHeaders: {
      "Accept-Language": profile.acceptLanguage,
    },
  });
  const page = await context.newPage();
  return { context, page, profile };
}

module.exports = {
  PROFILES,
  BLOCK_RE,
  pickProfile,
  blockKind,
  blockError,
  browserHeaders,
  shouldRetryOutcome,
  shouldRetry,
  backoff,
  withOneRetry,
  openPage,
};
