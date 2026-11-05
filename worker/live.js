/*
 * Live sources run together in one process. One failure does not cancel
 * the others. A block retry stays inside that source's own promise.
 */

const { normalizeAddress } = require("./address");
const { scrapeHomebot } = require("./homebot");
const { scrapeChase } = require("./chase");
const { scrapeRate } = require("./rate");
const { scrapeHar } = require("./har");

const SCRAPERS = {
  homebot: scrapeHomebot,
  chase: scrapeChase,
  rate: scrapeRate,
  har: scrapeHar,
};

const LIVE_SOURCE_IDS = ["homebot", "chase", "rate", "har"];

function parseSourceIds(value) {
  const raw = String(value || LIVE_SOURCE_IDS.join(","));
  const ids = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length ? ids : LIVE_SOURCE_IDS.slice();
}

function unavailable(sourceId, error) {
  return {
    sourceId,
    status: "unavailable",
    value: null,
    low: null,
    high: null,
    fetchedAt: new Date().toISOString(),
    error,
  };
}

async function runSources(address, sourceIds, options = {}) {
  const ids = [...new Set(sourceIds)];
  let normalized = address;
  try {
    normalized = await normalizeAddress(address);
  } catch (error) {
    normalized = address;
  }
  return Promise.all(ids.map(async (id) => {
    const scrape = SCRAPERS[id];
    let outcome;
    try {
      outcome = scrape ? await scrape(normalized, options) : unavailable(id, "This source is not connected.");
    } catch (error) {
      outcome = unavailable(id, "The lookup did not finish.");
    }
    if (typeof options.onResult === "function") {
      try {
        await options.onResult(outcome);
      } catch (error) {
        outcome.callbackError = true;
      }
    }
    return outcome;
  }));
}

module.exports = { SCRAPERS, LIVE_SOURCE_IDS, parseSourceIds, runSources };
