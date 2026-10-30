/*
 * Run the live sources once, then post each result.
 *
 * ADDRESS is read from the environment so it is not a process argument.
 * SOURCE_ID is a comma-separated list. The default is every live source.
 * This script does not print the address.
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

async function postResult(callbackUrl, secret, sessionId, outcome) {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + secret,
    },
    body: JSON.stringify({
      sessionId,
      sourceId: outcome.sourceId,
      status: outcome.status,
      value: outcome.value,
      low: outcome.low,
      high: outcome.high,
      fetchedAt: outcome.fetchedAt,
      error: outcome.error,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok && response.status !== 204) {
    throw new Error("Callback failed with " + response.status + " for " + outcome.sourceId);
  }
}

async function main() {
  maskAddress();

  const address = process.env.ADDRESS || "";
  // Always the full live set. One Actions job covers every card, even if
  // an older API sent a single source id.
  const sourceIds = LIVE_SOURCE_IDS;
  const sessionId = process.env.SESSION_ID || "";
  const callbackUrl = process.env.CALLBACK_URL || "";
  const secret = process.env.WORKER_SECRET || "";

  if (!address.trim()) {
    process.stderr.write("ADDRESS is required.\n");
    process.exit(1);
  }
  if (callbackUrl && (!secret || !sessionId)) {
    process.stderr.write("SESSION_ID and WORKER_SECRET are required to post a callback.\n");
    process.exit(1);
  }

  let callbackFailed = false;
  const outcomes = await runSources(address, sourceIds, {
    chromePath: process.env.CHROME_PATH || "",
    timeoutMs: 40000,
    onResult: async (outcome) => {
      process.stdout.write(outcome.sourceId + " " + outcome.status + (outcome.value == null ? "" : " " + outcome.value) + "\n");
      if (!callbackUrl) return;
      try {
        await postResult(callbackUrl, secret, sessionId, outcome);
      } catch (error) {
        callbackFailed = true;
        process.stderr.write(String(error.message || "Callback failed.") + "\n");
      }
    },
  });

  process.stdout.write(JSON.stringify(outcomes.map((outcome) => ({
    sourceId: outcome.sourceId,
    status: outcome.status,
    value: outcome.value,
    low: outcome.low,
    high: outcome.high,
    error: outcome.error,
  }))) + "\n");

  if (callbackFailed) process.exit(1);
}

main().catch(() => {
  process.stderr.write("Lookup failed.\n");
  process.exit(1);
});
