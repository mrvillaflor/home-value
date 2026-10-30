/*
 * One Homebot lookup, then an optional callback.
 *
 * ADDRESS is read from the environment so it is not a process argument.
 * This script does not print the address. On GitHub Actions the workflow
 * also registers it with the log mask. The Actions run page can still
 * show workflow_dispatch inputs on a public repo.
 */

const { scrapeHomebot } = require("./homebot");

function maskAddress() {
  const address = process.env.ADDRESS;
  if (!address) return;
  const lines = String(address).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    process.stdout.write("::add-mask::" + line + "\n");
  }
}

async function main() {
  maskAddress();

  const address = process.env.ADDRESS || "";
  const sourceId = process.env.SOURCE_ID || "homebot";
  const sessionId = process.env.SESSION_ID || "";
  const callbackUrl = process.env.CALLBACK_URL || "";
  const secret = process.env.WORKER_SECRET || "";

  if (sourceId !== "homebot") {
    process.stderr.write("This command only looks up Homebot.\n");
    process.exit(1);
  }
  if (!address.trim()) {
    process.stderr.write("ADDRESS is required.\n");
    process.exit(1);
  }

  const outcome = await scrapeHomebot(address, {
    chromePath: process.env.CHROME_PATH || "",
    timeoutMs: 40000,
  });

  if (callbackUrl) {
    if (!secret || !sessionId) {
      process.stderr.write("SESSION_ID and WORKER_SECRET are required to post a callback.\n");
      process.exit(1);
    }
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + secret,
      },
      body: JSON.stringify({
        sessionId,
        sourceId: "homebot",
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
      process.stderr.write("Callback failed with " + response.status + "\n");
      process.exit(1);
    }
  }

  process.stdout.write(
    JSON.stringify({
      status: outcome.status,
      value: outcome.value,
      low: outcome.low,
      high: outcome.high,
      error: outcome.error,
    }) + "\n"
  );
}

main().catch(() => {
  process.stderr.write("Lookup failed.\n");
  process.exit(1);
});
