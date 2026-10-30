/*
 * Home value lookup.
 *
 * SOURCES is the only list of estimate providers. Add or remove entries
 * here; the hero index and the results grid both follow it.
 * If a name changes, also update the identification sentence in the footer.
 *
 * API_BASE is the Render service. Change this one constant if the URL differs.
 * LIVE_SOURCE_ID is the only source the API asks the worker to fetch.
 *
 * Nothing on this page is written to localStorage, sessionStorage, or a cookie.
 * A refresh starts from an empty address and no results.
 */

const API_BASE = "https://home-value-api.onrender.com";
const LIVE_SOURCE_ID = "homebot";
const POLL_MS = 2000;
const POST_TIMEOUT_MS = 75000;
const POLL_BUDGET_MS = 90000;

const SOURCES = [
  { id: "redfin", name: "Redfin" },
  { id: "homebot", name: "Homebot" },
  { id: "zillow", name: "Zillow" },
  { id: "chase", name: "Chase" },
  { id: "pennymac", name: "PennyMac" },
  { id: "homes", name: "Homes.com" },
  { id: "rate", name: "Rate.com" },
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
  const kicker = card.querySelector(".source-kicker");
  const status = card.querySelector(".source-status");
  const detail = card.querySelector(".source-detail");
  if (kicker) kicker.textContent = "Estimate";
  status.textContent = formatDollars(source.value);
  if (typeof source.low === "number" && typeof source.high === "number") {
    detail.textContent = formatDollars(source.low) + " – " + formatDollars(source.high);
  } else {
    detail.textContent = "Homebot estimate";
  }
  card.dataset.state = "done";
}

function visitorError(error) {
  if (typeof error !== "string") return "No estimate returned";
  const text = error.replace(/\s+/g, " ").trim();
  if (!text || text.length > 160 || /<|>/.test(text)) return "No estimate returned";
  return text;
}

/*
 * Dollars are rendered only for the live source, and only when the API
 * says that source is done and sent a finite value. The other cards stay
 * on the placeholder.
 */
function applySource(card, source) {
  if (!source || source.id !== LIVE_SOURCE_ID) {
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
  detail.textContent = "Checking Homebot";
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
      "Waking up the server. This often takes about a minute. Homebot is the source being checked."
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

    if (source.id === LIVE_SOURCE_ID) {
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
 * POST /sessions { address } → { sessionId }
 * Then GET /sessions/:id about every 2 seconds for up to 90 seconds.
 * onUpdate is called with each session payload so the live card can fill
 * as soon as Homebot arrives. Other sources are left pending.
 */
async function fetchEstimates(address, onUpdate) {
  if (!address || typeof address !== "string") {
    throw new Error("A full address is required.");
  }

  const created = await requestJson(
    API_BASE + "/sessions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    },
    POST_TIMEOUT_MS
  );

  if (!created.sessionId) {
    throw new Error("The server did not start a lookup.");
  }

  const started = Date.now();
  let latest = null;
  while (Date.now() - started < POLL_BUDGET_MS) {
    latest = await requestJson(API_BASE + "/sessions/" + created.sessionId, { method: "GET" }, 15000);
    if (onUpdate) onUpdate(latest);
    const live = (latest.sources || []).find((source) => source.id === LIVE_SOURCE_ID);
    if (live && (live.status === "done" || live.status === "unavailable")) {
      return latest;
    }
    await sleep(POLL_MS);
  }
  return latest;
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
      const live = (update.sources || []).find((source) => source.id === LIVE_SOURCE_ID);
      if (live && live.status === "pending") {
        setNote("Checking Homebot. The other sources stay pending.");
      }
    });
    if (token !== currentRequest) return;

    const live = session && (session.sources || []).find((source) => source.id === LIVE_SOURCE_ID);
    if (live && live.status === "done") {
      paintSession(session);
      setNote("Homebot returned an estimate. The other sources are not connected yet.");
    } else if (live && live.status === "unavailable") {
      paintSession(session);
      setNote("Homebot did not return an estimate. The other sources are not connected yet.");
    } else {
      const card = results.querySelector('[data-source="' + LIVE_SOURCE_ID + '"]');
      if (card) showUnavailable(card, "The estimate did not arrive in time.");
      setNote("Homebot did not respond in time. No dollar amount is shown.");
    }
    results.setAttribute("aria-busy", "false");
  } catch (error) {
    if (token !== currentRequest) return;
    const card = results.querySelector('[data-source="' + LIVE_SOURCE_ID + '"]');
    const timedOut = error && error.name === "AbortError";
    if (card) {
      showUnavailable(card, timedOut ? "The server is still waking up. Try the address again." : "The lookup service did not respond.");
    }
    setNote(timedOut ? "The server did not wake up in time. No dollar amount is shown." : "The lookup service did not respond. No dollar amount is shown.");
    results.setAttribute("aria-busy", "false");
  }
});

writeSourceIndex();
clearPage();

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    clearPage();
    writeSourceIndex();
    return;
  }
  window.setTimeout(() => {
    if (!results.hidden) return;
    addressInput.value = "";
    hint.textContent = "";
  }, 0);
});
