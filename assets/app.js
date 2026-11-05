/*
 * Home value lookup.
 *
 * SOURCES is the only list of estimate providers. Add or remove entries
 * here; the hero index and the results grid both follow it.
 * If a name changes, also update the identification sentence in the footer.
 *
 * API_BASE is the Render service. Change this one constant if the URL differs.
 * LIVE_SOURCE_IDS are the sources the API asks the worker to fetch.
 *
 * Successful estimates are remembered in localStorage for 24 hours, per
 * source, under the normalized address. Failures are not remembered.
 * The address box is cleared on refresh and is not kept in the URL.
 */

const API_BASE = "https://home-value-api-3mvp.onrender.com";
const LIVE_SOURCE_IDS = ["homebot", "chase", "rate", "har"];
const ESTIMATE_LABELS = {
  homebot: "Homebot estimate",
  chase: "Chase estimate",
  rate: "Rate.com estimate",
  har: "HAR.com estimate",
};
const STORAGE_KEY = "home-value.results.v1";

function isLiveSource(id) {
  return LIVE_SOURCE_IDS.includes(id);
}

function liveSourceNames() {
  return SOURCES.filter((source) => isLiveSource(source.id)).map((source) => source.name).join(", ");
}
const POLL_MS = 2000;
const POST_TIMEOUT_MS = 90000;
const POLL_BUDGET_MS = 180000;

const SOURCES = [
  { id: "homebot", name: "Homebot" },
  { id: "chase", name: "Chase" },
  { id: "rate", name: "Rate.com" },
  { id: "har", name: "HAR.com" },
];

const lookupForm = document.querySelector("#lookup");
const addressInput = document.querySelector("#address");
const hint = document.querySelector("#lookup-hint");
const results = document.querySelector("#results");
const sourceIndex = document.querySelector("#source-index");

let currentRequest = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function isFullAddress(value) {
  if (value.length < 8 || value.length > 200) return false;
  if (!/\d/.test(value)) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  return true;
}

function cacheKey(address) {
  if (window.HomeValueAddress && typeof window.HomeValueAddress.cacheKey === "function") {
    return window.HomeValueAddress.cacheKey(address);
  }
  return String(address || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function loadStore() {
  const empty = window.HomeValueCache ? window.HomeValueCache.createStore() : { version: 1, entries: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return empty;
    return parsed;
  } catch (error) {
    return empty;
  }
}

function saveStore(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    // Private mode or a full disk. The lookup still runs.
  }
}

function readFresh(address) {
  if (!window.HomeValueCache) return {};
  const store = loadStore();
  const fresh = window.HomeValueCache.freshMap(store, cacheKey(address), Date.now(), window.HomeValueCache.TTL_MS);
  saveStore(store);
  return fresh;
}

function rememberSource(address, source) {
  if (!window.HomeValueCache || !source || !isLiveSource(source.id)) return;
  const store = loadStore();
  window.HomeValueCache.remember(store, cacheKey(address), source.id, {
    status: "done",
    value: source.value,
    low: source.low == null ? null : source.low,
    high: source.high == null ? null : source.high,
    fetchedAt: source.fetchedAt || new Date().toISOString(),
    error: null,
    estimates: source.estimates || null,
    url: source.url || null,
  }, Date.now(), window.HomeValueCache.TTL_MS);
  saveStore(store);
}

function rowFromHit(source, hit) {
  return {
    id: source.id,
    name: source.name,
    status: "done",
    value: hit.value,
    low: hit.low == null ? null : hit.low,
    high: hit.high == null ? null : hit.high,
    fetchedAt: hit.fetchedAt || null,
    error: null,
    estimates: hit.estimates || null,
    url: hit.url || null,
  };
}

function sessionFromSaved(address, saved) {
  return {
    sessionId: "local",
    address,
    fromBrowserCache: LIVE_SOURCE_IDS.every((id) => saved[id]),
    sources: SOURCES.map((source) => {
      if (!saved[source.id]) {
        return {
          id: source.id,
          name: source.name,
          status: "pending",
          value: null,
          low: null,
          high: null,
          fetchedAt: null,
          error: null,
        };
      }
      return rowFromHit(source, saved[source.id]);
    }),
  };
}

function mergeSaved(session, saved) {
  const rows = session && Array.isArray(session.sources) ? session.sources : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sources = SOURCES.map((source) => {
    const remote = byId.get(source.id);
    if (remote && remote.status === "done" && typeof remote.value === "number" && Number.isFinite(remote.value)) {
      return remote;
    }
    if (saved[source.id]) return rowFromHit(source, saved[source.id]);
    return remote || {
      id: source.id,
      name: source.name,
      status: "pending",
      value: null,
      low: null,
      high: null,
      fetchedAt: null,
      error: null,
    };
  });
  return Object.assign({}, session, { sources });
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatDollars(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function writeSourceIndex() {
  if (!sourceIndex) return;
  sourceIndex.replaceChildren();
  SOURCES.forEach((source) => {
    sourceIndex.append(el("li", null, source.name));
  });
}

function clearPage() {
  currentRequest += 1;
  if (lookupForm) lookupForm.reset();
  if (addressInput) {
    addressInput.value = "";
    addressInput.removeAttribute("aria-invalid");
  }
  if (hint) hint.textContent = "";
  if (results) {
    results.hidden = true;
    results.replaceChildren();
    results.removeAttribute("aria-busy");
  }
}

function setNote(text) {
  const note = results.querySelector(".results-note");
  if (note) note.textContent = text;
}

function showPlaceholder(card) {
  const slot = card.querySelector(".shimmer-slot");
  if (slot) slot.remove();
  const kicker = card.querySelector(".source-kicker");
  const status = card.querySelector(".source-status");
  const detail = card.querySelector(".source-detail");
  if (kicker) kicker.textContent = "Status";
  status.textContent = "Pending";
  detail.textContent = "Coming soon";
  card.dataset.state = "pending";
}

function showUnavailable(card, detail) {
  const slot = card.querySelector(".shimmer-slot");
  if (slot) slot.remove();
  const kicker = card.querySelector(".source-kicker");
  const status = card.querySelector(".source-status");
  const detailNode = card.querySelector(".source-detail");
  if (kicker) kicker.textContent = "Status";
  status.textContent = "Unavailable";
  detailNode.textContent = detail || "No estimate returned";
  card.dataset.state = "unavailable";
}

function showEstimate(card, source) {
  const slot = card.querySelector(".shimmer-slot");
  if (slot) slot.remove();
  const lines = card.querySelector(".har-lines");
  if (lines) lines.remove();
  const kicker = card.querySelector(".source-kicker");
  const status = card.querySelector(".source-status");
  const detail = card.querySelector(".source-detail");
  if (source.id === "har" && Array.isArray(source.estimates) && source.estimates.length) {
    showHarEstimates(card, source);
    return;
  }
  if (kicker) kicker.textContent = "Estimate";
  status.textContent = formatDollars(source.value);
  status.hidden = false;
  if (typeof source.low === "number" && typeof source.high === "number") {
    detail.textContent = formatDollars(source.low) + " – " + formatDollars(source.high);
  } else {
    detail.textContent = ESTIMATE_LABELS[source.id] || "Estimate";
  }
  card.dataset.state = "done";
}

function safeHarUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.har.com") return "";
    if (!/^\/homedetail\/[a-z0-9-]+\/\d+\/?$/i.test(url.pathname)) return "";
    if (url.search || url.hash) return "";
    return "https://www.har.com" + url.pathname.replace(/\/$/, "");
  } catch (error) {
    return "";
  }
}

function harMoney(value) {
  return formatDollars(value);
}

function showHarEstimates(card, source) {
  const kicker = card.querySelector(".source-kicker");
  const status = card.querySelector(".source-status");
  const detail = card.querySelector(".source-detail");
  if (kicker) kicker.textContent = "Estimates";
  status.textContent = "";
  status.hidden = true;
  detail.textContent = "";
  const lines = el("div", "har-lines");
  source.estimates.forEach((row) => {
    const line = el("p", "har-line");
    const name = el("span", "har-name", row.name + ":");
    let amount = harMoney(row.value);
    if (row.name === "Appraisal District") {
      amount += " (" + (Number.isInteger(row.year) ? String(row.year) : "year not listed") + ")";
    }
    const value = el("span", "har-value", amount);
    line.append(name, value);
    lines.append(line);
    const notes = [];
    if (typeof row.low === "number" && typeof row.high === "number") {
      notes.push(harMoney(row.low) + " – " + harMoney(row.high));
    }
    if (typeof row.confidence === "number") notes.push(String(row.confidence) + "%");
    if (notes.length) lines.append(el("p", "source-detail", notes.join(" · ")));
    if (row.name === "Appraisal District" && Array.isArray(row.prior)) {
      row.prior.forEach((item) => {
        if (!item || !Number.isInteger(item.year) || typeof item.value !== "number") return;
        lines.append(el("p", "source-detail", String(item.year) + ": " + harMoney(item.value)));
      });
    }
  });
  const harUrl = safeHarUrl(source.url);
  if (harUrl) {
    const credit = el("p", "source-detail");
    const link = el("a", null, "HAR.com");
    link.href = harUrl;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    credit.append(link);
    lines.append(credit);
  }
  detail.before(lines);
  card.dataset.state = "done";
}

function visitorError(error) {
  if (typeof error !== "string") return "No estimate returned";
  const text = error.replace(/\s+/g, " ").trim();
  if (!text || text.length > 160 || /<|>/.test(text)) return "No estimate returned";
  return text;
}

/*
 * Dollars are rendered only when a live source is done and sent a finite
 * value. A saved successful estimate from the last 24 hours counts too.
 */
function applySource(card, source) {
  if (!source || !isLiveSource(source.id)) {
    showPlaceholder(card);
    return;
  }
  if (source.status === "done" && typeof source.value === "number" && Number.isFinite(source.value)) {
    showEstimate(card, source);
    return;
  }
  if (source.status === "unavailable") {
    showUnavailable(card, visitorError(source.error));
    return;
  }
  const status = card.querySelector(".source-status");
  const detail = card.querySelector(".source-detail");
  status.textContent = "Loading";
  detail.textContent = "Looking up";
  card.dataset.state = "loading";
}

function renderLookup(address) {
  results.hidden = false;
  results.setAttribute("aria-busy", "true");
  results.replaceChildren();

  const wrap = el("div", "wrap");
  const head = el("div", "results-head");
  head.append(el("p", "results-kicker", "Sources"));
  const title = el("h2", null, address);
  title.id = "results-title";
  title.tabIndex = -1;
  head.append(
    title,
    el(
      "p",
      "results-note",
      "Waking up the server"
    )
  );

  const grid = el("div", "source-grid");
  grid.setAttribute("role", "list");

  SOURCES.forEach((source) => {
    const card = el("article", "source");
    card.dataset.source = source.id;
    card.setAttribute("role", "listitem");
    card.append(el("h3", null, source.name));
    card.append(el("p", "source-kicker", "Status"));
    card.append(el("p", "source-status", ""));
    card.append(el("p", "source-detail", ""));

    if (isLiveSource(source.id)) {
      const slot = el("div", "shimmer-slot");
      const shimmer = el("div", "shimmer");
      shimmer.setAttribute("aria-hidden", "true");
      slot.append(shimmer);
      card.insertBefore(slot, card.querySelector(".source-kicker"));
      card.querySelector(".source-status").textContent = "Loading";
      card.querySelector(".source-detail").textContent = "Waking up the server";
      card.dataset.state = "loading";
    } else {
      showPlaceholder(card);
    }
    grid.append(card);
  });

  wrap.append(head, grid);
  results.append(wrap);

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  results.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (typeof title.focus === "function") {
    try {
      title.focus({ preventScroll: true, focusVisible: false });
    } catch (error) {
      title.focus();
    }
  }
}

function paintSession(session) {
  const rows = session && Array.isArray(session.sources) ? session.sources : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  results.querySelectorAll(".source").forEach((card) => {
    applySource(card, byId.get(card.dataset.source));
  });
}

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "The server could not start a lookup.");
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * fetchEstimates(address)
 *
 * POST /sessions { address, have } → { sessionId }
 * Then GET /sessions/:id about every 2 seconds for up to 3 minutes.
 * A full set of saved successful estimates skips the request.
 * onUpdate is called with each payload so a card can fill as soon as
 * that source arrives.
 */
async function startSession(address, have) {
  const created = await requestJson(
    API_BASE + "/sessions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, have: have || [] }),
    },
    POST_TIMEOUT_MS
  );
  if (!created.sessionId) {
    throw new Error("The server did not start a lookup.");
  }
  return created.sessionId;
}

function liveSettled(session) {
  const rows = session && Array.isArray(session.sources) ? session.sources : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return LIVE_SOURCE_IDS.every((id) => {
    const row = byId.get(id);
    return row && (row.status === "done" || row.status === "unavailable");
  });
}

async function fetchEstimates(address, onUpdate) {
  if (!address || typeof address !== "string") {
    throw new Error("A full address is required.");
  }

  const saved = readFresh(address);
  const localSession = sessionFromSaved(address, saved);
  if (localSession.fromBrowserCache) {
    if (onUpdate) onUpdate(localSession);
    return localSession;
  }
  if (onUpdate && LIVE_SOURCE_IDS.some((id) => saved[id])) onUpdate(localSession);

  const have = LIVE_SOURCE_IDS.filter((id) => saved[id]);
  let sessionId = await startSession(address, have);
  let restarted = false;
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < POLL_BUDGET_MS) {
    try {
      latest = await requestJson(API_BASE + "/sessions/" + sessionId, { method: "GET" }, 15000);
    } catch (error) {
      // The free API forgets sessions when it restarts. One new lookup
      // replaces the lost one. A second 404 is reported as-is.
      if (error && error.status === 404 && !restarted) {
        restarted = true;
        sessionId = await startSession(address, have);
        continue;
      }
      throw error;
    }
    const merged = mergeSaved(latest, readFresh(address));
    (merged.sources || []).forEach((source) => {
      if (source.status === "done") rememberSource(address, source);
    });
    if (onUpdate) onUpdate(merged);
    if (liveSettled(merged)) return merged;
    await sleep(POLL_MS);
  }
  return latest ? mergeSaved(latest, readFresh(address)) : localSession;
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = addressInput.value.trim().replace(/\s+/g, " ");
  hint.textContent = "";

  if (!isFullAddress(address)) {
    addressInput.setAttribute("aria-invalid", "true");
    hint.textContent = "Enter a full street address, including city and state.";
    addressInput.focus();
    return;
  }

  addressInput.removeAttribute("aria-invalid");
  const token = ++currentRequest;
  renderLookup(address);

  try {
    const session = await fetchEstimates(address, (update) => {
      if (token !== currentRequest) return;
      paintSession(update);
      const pending = (update.sources || []).some((source) => isLiveSource(source.id) && source.status === "pending");
      if (pending) setNote("Looking up " + liveSourceNames());
    });
    if (token !== currentRequest) return;

    if (session && session.fromBrowserCache) {
      paintSession(session);
      setNote("Saved estimates from the last 24 hours.");
      results.setAttribute("aria-busy", "false");
      return;
    }

    const liveRows = session && (session.sources || []).filter((source) => isLiveSource(source.id));
    const finished = liveRows && liveRows.length === LIVE_SOURCE_IDS.length && liveRows.every((source) => source.status === "done" || source.status === "unavailable");
    if (finished) {
      paintSession(session);
      setNote("Homebot, Chase, Rate.com, and HAR.com have been checked.");
    } else {
      results.querySelectorAll(".source").forEach((card) => {
        if (isLiveSource(card.dataset.source) && card.dataset.state === "loading") {
          showUnavailable(card, "The estimate did not arrive in time.");
        }
      });
      setNote("A live source did not respond in time. No dollar amount was added for it.");
    }
    results.setAttribute("aria-busy", "false");
  } catch (error) {
    if (token !== currentRequest) return;
    const timedOut = error && error.name === "AbortError";
    const apiMessage = error && error.status ? visitorError(error.message) : "";
    const detail = timedOut
      ? "The server is still waking up. Try the address again."
      : (apiMessage && apiMessage !== "No estimate returned" ? apiMessage : "The lookup service did not respond.");
    results.querySelectorAll(".source").forEach((card) => {
      if (!isLiveSource(card.dataset.source)) return;
      if (card.dataset.state === "done") return;
      showUnavailable(card, detail);
    });
    setNote(timedOut ? "The server did not wake up in time. No dollar amount is shown." : detail);
    results.setAttribute("aria-busy", "false");
  }
});

writeSourceIndex();
clearPage();

window.addEventListener("pageshow", () => {
  clearPage();
  writeSourceIndex();
});
