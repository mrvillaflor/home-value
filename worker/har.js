/*
 * HAR.com public home-value page.
 * The finder and the property page are plain GETs. A desktop Chrome
 * Accept header is required; anything else is a PerimeterX block.
 * Houston-area homes only. No match is Unavailable. No signup.
 */

const FINDER_URL = "https://www.har.com/api/typeapp/homevaluesfinder?for=address&query=";
const LISTING_URL = "https://www.har.com/api/typeapp/mainlistingNS?query=";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const BLOCK_RE = /px-captcha|access to this page has been denied|verify you are human/i;
const NAMES = ["ICE", "Cotality", "Appraisal District"];

function outcome(status, extra) {
  return {
    sourceId: "har",
    status,
    value: extra.value ?? null,
    low: extra.low ?? null,
    high: extra.high ?? null,
    fetchedAt: new Date().toISOString(),
    error: status === "unavailable" ? extra.error || "No estimate returned" : null,
    estimates: extra.estimates || null,
    url: extra.url || null,
  };
}

function money(raw) {
  if (raw == null || raw === "") return null;
  const value = Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value) || value < 10000 || value > 100000000) return null;
  return Math.round(value);
}

function yearNumber(raw) {
  const match = String(raw == null ? "" : raw).match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1990 || year > 2099) return null;
  return year;
}

function confidenceNumber(raw) {
  if (raw == null || raw === "") return null;
  const value = Number(String(raw).replace(/%/g, "").trim());
  if (!Number.isFinite(value)) return null;
  if (value > 0 && value <= 1) return Math.round(value * 100);
  if (value > 1 && value <= 100) return Math.round(value);
  return null;
}

function addressParts(address) {
  const text = String(address || "");
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  const numberMatch = text.match(/\d+/);
  return {
    number: numberMatch ? numberMatch[0] : "",
    zip: zipMatch ? zipMatch[1] : "",
  };
}

function hasToken(text, token) {
  if (!token) return false;
  return new RegExp("(?:^|[^0-9])" + token + "(?:[^0-9]|$)").test(String(text || ""));
}

function propertyUrl(myurl) {
  if (typeof myurl !== "string") return null;
  const path = myurl.trim();
  if (!/^\/homedetail\/[a-z0-9-]+\/\d+\/?$/i.test(path)) return null;
  return "https://www.har.com" + path.replace(/\/$/, "");
}

function finderRows(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    return null;
  }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function matchingRow(address, rows) {
  const parts = addressParts(address);
  if (!parts.number || !parts.zip) return null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const url = propertyUrl(row.myurl);
    if (!url) continue;
    const blob = url + " " + JSON.stringify(row);
    if (hasToken(blob, parts.number) && hasToken(blob, parts.zip)) return { url, row };
  }
  return null;
}

function pageText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/g, "&")
    .replace(/\s+/g, " ");
}

function assessedByYear(html) {
  const text = pageText(html);
  const byYear = new Map();
  const assessed = /(19\d{2}|20\d{2})\s+Assessed Value\/Appraisal District:\s*\$?\s*([\d,]{4,})/g;
  let match;
  while ((match = assessed.exec(text))) {
    const year = yearNumber(match[1]);
    const value = money(match[2]);
    if (year != null && value != null && !byYear.has(year)) byYear.set(year, value);
  }
  const market = /\$\s*([\d,]{4,})\s+(19\d{2}|20\d{2})\s+Market Value Per Appraisal District/g;
  while ((match = market.exec(text))) {
    const year = yearNumber(match[2]);
    const value = money(match[1]);
    if (year != null && value != null && !byYear.has(year)) byYear.set(year, value);
  }
  return [...byYear.entries()]
    .map(([year, value]) => ({ year, value }))
    .sort((a, b) => b.year - a.year);
}

function datasetYear(dataset) {
  const direct = yearNumber(dataset && dataset.temporalCoverage);
  if (direct != null && String(dataset.temporalCoverage).trim() === String(direct)) return direct;
  const measured = dataset && Array.isArray(dataset.variableMeasured) ? dataset.variableMeasured : [];
  for (const item of measured) {
    const name = String(item && item.name || "");
    if (/tax year|assessment year|appraisal year/i.test(name)) {
      const year = yearNumber(item.value);
      if (year != null) return year;
    }
    const named = name.match(/^(19\d{2}|20\d{2})\b/);
    if (named) return Number(named[1]);
  }
  return null;
}

function graphsFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data["@graph"])) return data["@graph"];
  return data ? [data] : [];
}

function labelFor(name) {
  const text = String(name || "");
  if (/^ICE\b/i.test(text)) return "ICE";
  if (/^Cotality\b/i.test(text)) return "Cotality";
  if (/^Appraisal District\b/i.test(text)) return "Appraisal District";
  return null;
}

function readDatasets(html) {
  const found = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch (error) {
      continue;
    }
    for (const graph of graphsFrom(data)) {
      if (!graph || graph["@type"] !== "Dataset") continue;
      const name = labelFor(graph.name);
      if (!name) continue;
      const measured = Array.isArray(graph.variableMeasured) ? graph.variableMeasured : [];
      const row = { name, value: null, low: null, high: null, confidence: null, year: datasetYear(graph) };
      for (const item of measured) {
        const itemName = String(item && item.name || "");
        if (itemName.startsWith("AVM")) {
          row.value = money(item.value);
          row.low = money(item.minValue);
          row.high = money(item.maxValue);
        } else if (itemName.startsWith("Conf")) {
          row.confidence = confidenceNumber(item.value);
        }
      }
      if (row.value != null) found.push(row);
    }
  }
  return found;
}

function bracket(value, low, high) {
  if (low != null && high != null && low <= value && value <= high) return { low, high };
  return { low: null, high: null };
}

function parseHarPage(html) {
  const datasets = readDatasets(html);
  const years = assessedByYear(html);
  const estimates = [];
  for (const name of ["ICE", "Cotality"]) {
    const row = datasets.find((item) => item.name === name);
    if (!row) continue;
    const range = bracket(row.value, row.low, row.high);
    estimates.push({
      name,
      value: row.value,
      low: range.low,
      high: range.high,
      confidence: row.confidence,
      year: null,
      prior: [],
    });
  }

  const card = datasets.find((item) => item.name === "Appraisal District");
  if (years.length) {
    const [latest, ...older] = years;
    estimates.push({
      name: "Appraisal District",
      value: latest.value,
      low: null,
      high: null,
      confidence: null,
      year: latest.year,
      prior: older.slice(0, 4),
    });
  } else if (card) {
    estimates.push({
      name: "Appraisal District",
      value: card.value,
      low: null,
      high: null,
      confidence: null,
      year: card.year,
      prior: [],
    });
  }

  return estimates.filter((item) => NAMES.includes(item.name));
}

async function harGet(url, accept, timeoutMs) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": CHROME_UA,
      Accept: accept,
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  const blocked = response.status === 403 || response.status === 429 || BLOCK_RE.test(body.slice(0, 5000));
  return { status: response.status, body, blocked };
}

async function findProperty(address, timeoutMs) {
  const urls = [FINDER_URL + encodeURIComponent(address)];
  let sawBlock = false;
  for (const url of urls) {
    const result = await harGet(url, "application/json", timeoutMs);
    if (result.blocked) {
      sawBlock = true;
      break;
    }
    if (result.status !== 200) continue;
    const rows = finderRows(result.body);
    if (rows == null) continue;
    const match = matchingRow(address, rows);
    if (match) return match;
    urls.push(LISTING_URL + encodeURIComponent(address));
    break;
  }
  if (urls.length > 1) {
    const result = await harGet(urls[1], "application/json", timeoutMs);
    if (result.blocked) return { blocked: true };
    if (result.status === 200) {
      const rows = finderRows(result.body);
      const match = rows && matchingRow(address, rows);
      if (match) return match;
    }
  }
  if (sawBlock) return { blocked: true };
  return null;
}

async function scrapeHar(address, options = {}) {
  const timeoutMs = Math.min(20000, options.timeoutMs || 20000);
  let found;
  try {
    found = await findProperty(address, timeoutMs);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "HAR.com did not respond in time." });
    return outcome("unavailable", { error: "HAR.com did not show an estimate." });
  }
  if (found && found.blocked) return outcome("unavailable", { error: "HAR.com blocked the address search." });
  if (!found) return outcome("unavailable", { error: "HAR.com did not find this home." });

  let page;
  try {
    page = await harGet(found.url, HTML_ACCEPT, timeoutMs);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/timeout/i.test(message)) return outcome("unavailable", { error: "HAR.com did not respond in time." });
    return outcome("unavailable", { error: "HAR.com did not show an estimate." });
  }
  if (page.blocked || page.status !== 200) {
    return outcome("unavailable", { error: "HAR.com blocked the property page." });
  }
  const estimates = parseHarPage(page.body);
  if (!estimates.length) return outcome("unavailable", { error: "HAR.com did not show an estimate." });
  const primary = estimates.find((item) => item.name === "ICE") || estimates[0];
  const range = bracket(primary.value, primary.low, primary.high);
  return outcome("done", {
    value: primary.value,
    low: range.low,
    high: range.high,
    estimates,
    url: found.url,
  });
}

module.exports = { scrapeHar, parseHarPage, matchingRow, propertyUrl };
