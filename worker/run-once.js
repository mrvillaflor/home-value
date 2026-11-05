/*
 * Run the live sources once, then post each result.
 *
 * ADDRESS is read from the environment so it is not a process argument.
 * SOURCE_ID is a comma-separated list. The default is every live source.
 * This script does not print the address.
 *
 * LOOKUP_DRY_RUN=1 posts synthetic results and skips the scrapers. It is
 * only honored when the callback is empty or on localhost, so a stray
 * flag cannot publish a fake estimate.
 */

const { LIVE_SOURCE_IDS, runSources } = require("./live");

function maskAddress() {
  const address = process.env.ADDRESS;
  if (!address) return;
  const lines = String(address).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    process.stdout.write("::add-mask::" + line + "\n");
  }
}

function sourceIdsForRun() {
  const requested = String(process.env.SOURCE_ID || "")
    .split(",")
    .map((item) => item.trim())
    .filter((id) => LIVE_SOURCE_IDS.includes(id));
  const unique = [...new Set(requested)];
  return unique.length ? unique : LIVE_SOURCE_IDS.slice();
}

function localhostCallback(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch (error) {
    return false;
  }
}

async function postResult(callbackUrl, secret, sessionId, address, outcome) {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + secret,
    },
    body: JSON.stringify({
      sessionId,
      address,
      sourceId: outcome.sourceId,
      status: outcome.status,
      value: outcome.value,
      low: outcome.low,
      high: outcome.high,
      fetchedAt: outcome.fetchedAt,
      error: outcome.error,
      estimates: outcome.estimates || null,
      url: outcome.url || null,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok && response.status !== 204) {
    throw new Error("Callback failed with " + response.status + " for " + outcome.sourceId);
  }
}

function dryOutcomes(sourceIds) {
  return sourceIds.map((sourceId, index) => {
    if (index === 0) {
      return {
        sourceId,
        status: "done",
        value: 250000,
        low: 240000,
        high: 260000,
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    }
    return {
      sourceId,
      status: "unavailable",
      value: null,
      low: null,
      high: null,
      fetchedAt: new Date().toISOString(),
      error: "Dry run",
    };
  });
}

async function main() {
  maskAddress();

  const address = process.env.ADDRESS || "";
  const sourceIds = sourceIdsForRun();
  const sessionId = process.env.SESSION_ID || "";
  const callbackUrl = process.env.CALLBACK_URL || "";
  const secret = process.env.WORKER_SECRET || "";
  const dryRun = process.env.LOOKUP_DRY_RUN === "1";

  if (!address.trim()) {
    process.stderr.write("ADDRESS is required.\n");
    process.exit(1);
  }
  if (dryRun && !localhostCallback(callbackUrl)) {
    process.stderr.write("LOOKUP_DRY_RUN is only honored for a localhost callback.\n");
    process.exit(1);
  }
  if (callbackUrl && (!secret || !sessionId)) {
    process.stderr.write("SESSION_ID and WORKER_SECRET are required to post a callback.\n");
    process.exit(1);
  }

  let callbackFailed = false;
  const onResult = async (outcome) => {
    process.stdout.write(outcome.sourceId + " " + outcome.status + (outcome.value == null ? "" : " " + outcome.value) + "\n");
    if (!callbackUrl) return;
    try {
      await postResult(callbackUrl, secret, sessionId, address, outcome);
    } catch (error) {
      callbackFailed = true;
      process.stderr.write(String(error.message || "Callback failed.") + "\n");
    }
  };

  const outcomes = dryRun
    ? dryOutcomes(sourceIds)
    : await runSources(address, sourceIds, {
      chromePath: process.env.CHROME_PATH || "",
      timeoutMs: 40000,
      onResult,
    });

  if (dryRun) {
    for (const outcome of outcomes) {
      await onResult(outcome);
    }
  }

  process.stdout.write(JSON.stringify(outcomes.map((outcome) => ({
    sourceId: outcome.sourceId,
    status: outcome.status,
    value: outcome.value,
    low: outcome.low,
    high: outcome.high,
    error: outcome.error,
    estimates: outcome.estimates || null,
  }))) + "\n");

  if (callbackFailed) process.exit(1);
}

main().catch(() => {
  process.stderr.write("Lookup failed.\n");
  process.exit(1);
});
