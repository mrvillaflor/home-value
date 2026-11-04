/*
 * Client reviews: draws 9 random reviews from assets/reviews.json.
 * No reviewer appears twice in one set (keyed by display name).
 * "Show me more" draws a new set, skipping reviews already shown this
 * visit until the pool runs low. Nothing is stored in cookies or storage.
 */
(function () {
  "use strict";
  var SET_SIZE = 9;
  var CLAMP_CHARS = 420;
  var HAR_URL = window.REVIEWS_HAR_URL;
  var grid = document.getElementById("review-grid");
  var moreBtn = document.getElementById("more");
  var all = [];
  var seen = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function rand(n) {
    if (window.crypto && crypto.getRandomValues) {
      var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }
  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = rand(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function personKey(r) { return r.display_name.toLowerCase().replace(/[^a-z]/g, ""); }

  function pick() {
    var fresh = all.filter(function (r) { return !seen[r.id]; });
    var freshPeople = {};
    fresh.forEach(function (r) { freshPeople[personKey(r)] = 1; });
    if (Object.keys(freshPeople).length < SET_SIZE) { seen = {}; fresh = all; }
    var set = [], people = {};
    var order = shuffle(fresh);
    for (var i = 0; i < order.length && set.length < SET_SIZE; i++) {
      var k = personKey(order[i]);
      if (people[k]) continue;
      people[k] = 1; set.push(order[i]);
    }
    set.forEach(function (r) { seen[r.id] = 1; });
    return set;
  }

  function card(r) {
    var art = el("article", "rv-card");
    art.setAttribute("data-id", r.id);
    var src = el("p", "rv-source");
    if (r.source === "HAR") {
      src.appendChild(el("span", null, "HAR.com client rating"));
      var a = el("a", null, "See all ratings on HAR.com");
      a.href = HAR_URL; a.target = "_blank"; a.rel = "noopener";
      src.appendChild(a);
    } else {
      src.appendChild(el("span", null, "LinkedIn recommendation"));
    }
    art.appendChild(src);
    if (typeof r.score === "number") {
      var st = el("p", "rv-stars");
      var bar = el("span", "rv-stars-bar");
      bar.setAttribute("aria-hidden", "true");
      bar.appendChild(el("span", "rv-stars-bg"));
      var fg = el("span", "rv-stars-fg");
      fg.style.width = (r.score / 5 * 100) + "%";
      bar.appendChild(fg);
      st.appendChild(bar);
      st.appendChild(el("span", null, r.score + " out of 5"));
      art.appendChild(st);
    }
    var txt = el("p", "rv-text", r.text);
    art.appendChild(txt);
    if (r.text.length > CLAMP_CHARS) {
      txt.classList.add("is-clamped");
      txt.id = "rv-text-" + r.id;
      var b = el("button", "rv-toggle", "Read more");
      b.type = "button";
      b.setAttribute("aria-expanded", "false");
      b.setAttribute("aria-controls", txt.id);
      b.addEventListener("click", function () {
        var open = txt.classList.toggle("is-clamped") === false;
        b.textContent = open ? "Show less" : "Read more";
        b.setAttribute("aria-expanded", String(open));
      });
      art.appendChild(b);
    }
    var who = el("div", "rv-who");
    who.appendChild(el("p", "rv-name", r.display_name));
    if (r.context) who.appendChild(el("p", "rv-context", r.context));
    var d = el("p", "rv-date");
    var t = el("time", null, r.date); t.dateTime = r.date_iso; d.appendChild(t);
    who.appendChild(d);
    art.appendChild(who);
    return art;
  }

  function render() {
    var set = pick();
    grid.textContent = "";
    set.forEach(function (r) { grid.appendChild(card(r)); });
  }

  fetch("assets/reviews.json", { credentials: "omit" })
    .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
    .then(function (data) {
      all = data;
      render();
      moreBtn.hidden = false;
      moreBtn.addEventListener("click", function () {
        render();
        document.getElementById("reviews-title").scrollIntoView({ block: "start" });
      });
    })
    .catch(function () {
      grid.appendChild(el("p", "results-note", "Reviews could not be loaded. Please refresh the page, or see all ratings on HAR.com."));
    });
})();
