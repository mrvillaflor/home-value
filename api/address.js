/*
 * Shared address normalization for the API, the worker, and the page.
 * The Render service only ships the api/ directory, and GitHub Pages
 * serves this same file to the browser. Cache keys use the local parse
 * so "Drive" and "Dr" match without calling the Census geocoder.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HomeValueAddress = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
/*
 * Turn a typed address into "street, city, ST ZIP".
 * The Census one-line geocoder is free and needs no key. If it does not
 * answer, a local parse still accepts missing commas, full state names,
 * and spelled-out street suffixes (Drive, Street, Road, and the rest).
 */

const SUFFIXES = [
  ["parkway", "Pkwy"],
  ["freeway", "Fwy"],
  ["highway", "Hwy"],
  ["boulevard", "Blvd"],
  ["terrace", "Ter"],
  ["circle", "Cir"],
  ["court", "Ct"],
  ["drive", "Dr"],
  ["street", "St"],
  ["avenue", "Ave"],
  ["place", "Pl"],
  ["trail", "Trl"],
  ["lane", "Ln"],
  ["road", "Rd"],
  ["loop", "Loop"],
  ["cove", "Cv"],
  ["point", "Pt"],
  ["square", "Sq"],
  ["crossing", "Xing"],
  ["way", "Way"],
  ["path", "Path"],
  ["pass", "Pass"],
  ["run", "Run"],
];

const STATE_NAMES = [
  ["district of columbia", "DC"],
  ["north carolina", "NC"],
  ["north dakota", "ND"],
  ["south carolina", "SC"],
  ["south dakota", "SD"],
  ["west virginia", "WV"],
  ["new hampshire", "NH"],
  ["new jersey", "NJ"],
  ["new mexico", "NM"],
  ["new york", "NY"],
  ["rhode island", "RI"],
  ["alabama", "AL"],
  ["alaska", "AK"],
  ["arizona", "AZ"],
  ["arkansas", "AR"],
  ["california", "CA"],
  ["colorado", "CO"],
  ["connecticut", "CT"],
  ["delaware", "DE"],
  ["florida", "FL"],
  ["georgia", "GA"],
  ["hawaii", "HI"],
  ["idaho", "ID"],
  ["illinois", "IL"],
  ["indiana", "IN"],
  ["iowa", "IA"],
  ["kansas", "KS"],
  ["kentucky", "KY"],
  ["louisiana", "LA"],
  ["maine", "ME"],
  ["maryland", "MD"],
  ["massachusetts", "MA"],
  ["michigan", "MI"],
  ["minnesota", "MN"],
  ["mississippi", "MS"],
  ["missouri", "MO"],
  ["montana", "MT"],
  ["nebraska", "NE"],
  ["nevada", "NV"],
  ["ohio", "OH"],
  ["oklahoma", "OK"],
  ["oregon", "OR"],
  ["pennsylvania", "PA"],
  ["tennessee", "TN"],
  ["texas", "TX"],
  ["utah", "UT"],
  ["vermont", "VT"],
  ["virginia", "VA"],
  ["washington", "WA"],
  ["wisconsin", "WI"],
  ["wyoming", "WY"],
];

const STATE_ABBR = new Set(STATE_NAMES.map((row) => row[1]));

const MULTI_CITIES = [
  "west university place",
  "north richland hills",
  "the woodlands",
  "college station",
  "missouri city",
  "jersey village",
  "league city",
  "sugar land",
  "cedar park",
  "round rock",
  "new braunfels",
  "san antonio",
  "fort worth",
  "el paso",
  "corpus christi",
  "grand prairie",
  "port arthur",
  "texas city",
  "la marque",
  "la porte",
  "lake jackson",
  "west columbia",
  "clear lake",
  "deer park",
  "iowa colony",
];

const CITY_PREFIXES = new Set([
  "north", "south", "east", "west", "new", "san", "fort", "el", "la", "los", "las",
  "lake", "port", "mount", "saint",
]);

const STREET_TOKENS = new Set([
  "dr", "drive", "st", "street", "rd", "road", "ave", "avenue", "blvd", "boulevard",
  "ln", "lane", "ct", "court", "cir", "circle", "pl", "place", "trl", "trail",
  "pkwy", "parkway", "hwy", "highway", "fwy", "freeway", "ter", "terrace",
  "way", "loop", "cv", "cove", "pt", "point", "sq", "square", "xing", "crossing",
  "path", "pass", "run",
]);

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase());
}

function abbreviateStreet(street) {
  let text = String(street || "").replace(/\./g, " ");
  for (const [long, short] of SUFFIXES) {
    text = text.replace(new RegExp("\\b" + long + "\\b", "ig"), short);
  }
  return titleCase(text.replace(/\s+/g, " ").trim());
}

function takeZip(text) {
  const match = text.match(/,?\s*(\d{5})(?:-\d{4})?\s*$/);
  if (!match) return null;
  return {
    zip: match[1],
    rest: text.slice(0, match.index).replace(/[,\s]+$/, ""),
  };
}

function takeState(text) {
  const trimmed = text.replace(/[,\s]+$/, "");
  const lower = trimmed.toLowerCase();
  for (const [name, abbr] of STATE_NAMES) {
    if (!lower.endsWith(name)) continue;
    const boundary = lower.length - name.length;
    if (boundary === 0 || /[\s,]/.test(lower.charAt(boundary - 1))) {
      return { state: abbr, rest: trimmed.slice(0, boundary).replace(/[,\s]+$/, "") };
    }
  }
  const match = trimmed.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (match && STATE_ABBR.has(match[2].toUpperCase())) {
    return { state: match[2].toUpperCase(), rest: match[1].replace(/[,\s]+$/, "") };
  }
  return null;
}

function splitStreetCity(text) {
  const flat = text.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const tokens = flat.split(" ").filter(Boolean);
  if (tokens.length < 2) return null;
  const lower = tokens.map((token) => token.toLowerCase());
  const cities = MULTI_CITIES.slice().sort((a, b) => b.length - a.length);
  for (const name of cities) {
    const parts = name.split(" ");
    if (tokens.length <= parts.length) continue;
    if (lower.slice(-parts.length).join(" ") === name) {
      return {
        street: tokens.slice(0, -parts.length).join(" "),
        city: tokens.slice(-parts.length).join(" "),
      };
    }
  }
  const previous = lower[lower.length - 2];
  if (tokens.length >= 3 && CITY_PREFIXES.has(previous) && !STREET_TOKENS.has(previous)) {
    return {
      street: tokens.slice(0, -2).join(" "),
      city: tokens.slice(-2).join(" "),
    };
  }
  return {
    street: tokens.slice(0, -1).join(" "),
    city: tokens[tokens.length - 1],
  };
}

function parseLoose(address) {
  let text = String(address || "").trim().replace(/\s+/g, " ");
  text = text.replace(/,?\s*(usa|united states)\.?$/i, "").trim();
  const zip = takeZip(text);
  if (!zip) return null;
  const state = takeState(zip.rest);
  if (!state) return null;
  const place = splitStreetCity(state.rest);
  if (!place) return null;
  const street = abbreviateStreet(place.street);
  const city = titleCase(place.city);
  if (street.length < 3 || !/\d/.test(street) || city.length < 2) return null;
  return { street, city, state: state.state, zip: zip.zip };
}

function formatAddress(parts) {
  return parts.street + ", " + parts.city + ", " + parts.state + " " + parts.zip;
}

function unitToken(street) {
  const match = String(street || "").match(/\b(?:unit|apt|apartment|suite|ste|#)\s*[A-Za-z0-9-]+\b/i);
  return match ? match[0] : "";
}

function withUnit(street, unit) {
  if (!unit) return street;
  if (new RegExp(unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(street)) return street;
  return (street + " " + unit).replace(/\s+/g, " ").trim();
}

function harStreetQuery(address) {
  const parts = parseLoose(address);
  if (!parts) return "";
  let street = parts.street.replace(/\b(?:unit|apt|apartment|suite|ste|#)\b.*$/i, "").trim();
  street = street.replace(/\b(?:Dr|St|Rd|Ave|Blvd|Ln|Ct|Cir|Pl|Trl|Pkwy|Hwy|Ter|Fwy|Way|Loop|Cv|Pt|Sq|Xing)\b\.?$/i, "").trim();
  return street.replace(/\s+/g, " ");
}

async function censusParts(address) {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const match = data && data.result && Array.isArray(data.result.addressMatches)
    ? data.result.addressMatches[0]
    : null;
  if (!match || typeof match.matchedAddress !== "string") return null;
  const parts = parseLoose(match.matchedAddress);
  if (!parts) return null;
  const local = parseLoose(address);
  parts.street = abbreviateStreet(withUnit(parts.street, local && unitToken(local.street)));
  return parts;
}

async function normalizeAddress(address) {
  const raw = String(address || "").trim().replace(/\s+/g, " ");
  if (!raw) return raw;
  try {
    const geocoded = await censusParts(raw);
    if (geocoded) return formatAddress(geocoded);
  } catch (error) {
    // Census is a helper. The local parse below still runs.
  }
  const local = parseLoose(raw);
  if (!local) return raw;
  return formatAddress(local);
}



function cacheKey(address) {
  const raw = String(address || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const local = parseLoose(raw);
  return (local ? formatAddress(local) : raw).toLowerCase();
}

  return {
    parseLoose,
    formatAddress,
    harStreetQuery,
    normalizeAddress,
    cacheKey,
  };
});
