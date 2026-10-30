/*
 * Home value lookup.
 *
 * SOURCES is the only list of estimate providers. Add or remove entries
 * here; the hero index and the results grid both follow it.
 * If a name changes, also update the identification sentence in the footer.
 *
 * Nothing on this page is written to localStorage, sessionStorage, or a cookie.
 * A refresh starts from an empty address and no results.
 */

const SOURCES = [
  { id: "redfin", name: "Redfin" },
  { id: "homebot", name: "Homebot" },
  { id: "zillow", name: "Zillow" },
  { id: "chase", name: "Chase" },
  { id: "pennymac", name: "PennyMac" },
  { id: "homes", name: "Homes.com" },
  { id: "rate", name: "Rate.com" },
];

/**
 * fetchEstimates(address)
 *
 * Plug-in point for a future Render web service.
 *
 * Planned contract:
 *   1. POST the address. The service returns a session id.
 *   2. Poll that session. Each source resolves on its own.
 *   3. Return one row per source: { id, status, estimate }.
 *
 * Do not invent dollar amounts. `estimate` stays null until a source
 * actually returns a figure. This draft does not call the network. It
 * pauses so the loading state is visible, then marks every configured
 * source pending.
 *
 * @param {string} address
 * @returns {Promise<Array<{ id: string, name: string, status: "pending", label: string, estimate: null }>>}
 */
async function fetchEstimates(address) {
  if (!address || typeof address !== "string") {
    throw new Error("A full address is required.");
  }

  // DRAFT ONLY. Delete this pause when the session request above is real.
  await new Promise((resolve) => {
    window.setTimeout(resolve, 700);
  });

  return SOURCES.map((source) => ({
    id: source.id,
    name: source.name,
    status: "pending",
    label: "Coming soon",
    estimate: null,
  }));
}

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

function renderLoading(address) {
  results.hidden = false;
  results.setAttribute("aria-busy", "true");
  results.replaceChildren();

  const wrap = el("div", "wrap");
  const head = el("div", "results-head");
  head.append(el("p", "results-kicker", "Sources"));
  const title = el("h2", null, address);
  title.id = "results-title";
  title.tabIndex = -1;
  const note = el(
    "p",
    "results-note",
    "Loading " + SOURCES.length + " sources. No dollar amount will be shown."
  );
  head.append(title, note);

  const grid = el("div", "source-grid");
  grid.setAttribute("role", "list");

  SOURCES.forEach((source) => {
    const card = el("article", "source");
    card.dataset.source = source.id;
    card.dataset.state = "loading";
    card.setAttribute("role", "listitem");
    card.append(el("h3", null, source.name));

    const slot = el("div", "shimmer-slot");
    const shimmer = el("div", "shimmer");
    shimmer.setAttribute("aria-hidden", "true");
    slot.append(shimmer);

    card.append(
      slot,
      el("p", "source-kicker", "Status"),
      el("p", "source-status", "Loading"),
      el("p", "source-detail", "Coming soon")
    );
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

/*
 * This draft always prints the placeholder, even if a row carries an
 * estimate field. When the API is live, render a real figure here and
 * only here — never a stand-in number.
 */
function showPlaceholder(card) {
  const slot = card.querySelector(".shimmer-slot");
  if (slot) slot.remove();
  const status = card.querySelector(".source-status");
  const detail = card.querySelector(".source-detail");
  status.textContent = "Pending";
  detail.textContent = "Coming soon";
  card.dataset.state = "pending";
}

function showProblem() {
  results.setAttribute("aria-busy", "false");
  const note = results.querySelector(".results-note");
  if (note) {
    note.textContent = "The sources could not be listed. Enter the address again. No dollar amount is shown.";
  }
  results.querySelectorAll(".source").forEach(showPlaceholder);
}

async function presentRows(rows, token) {
  const returned = new Map(Array.isArray(rows) ? rows.map((row) => [row.id, row]) : []);
  const cards = [...results.querySelectorAll(".source")];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  for (const card of cards) {
    if (token !== currentRequest) return;
    const row = returned.get(card.dataset.source);
    // row.estimate is intentionally unused. This draft never prints a figure.
    void row;
    showPlaceholder(card);
    if (!reduce) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 90);
      });
    }
  }

  if (token !== currentRequest) return;
  const note = results.querySelector(".results-note");
  if (note) {
    note.textContent = "Pending. No dollar amount is shown. These placeholders are not figures from the sources.";
  }
  results.setAttribute("aria-busy", "false");
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
  renderLoading(address);

  try {
    const rows = await fetchEstimates(address);
    if (token !== currentRequest) return;
    await presentRows(rows, token);
  } catch (error) {
    if (token !== currentRequest) return;
    showProblem();
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
  // A normal reload can restore the field after this script runs.
  window.setTimeout(() => {
    if (!results.hidden) return;
    addressInput.value = "";
    hint.textContent = "";
  }, 0);
});
