/* Idea Receipt — renders data.json as a shop receipt and polls for changes.
   Every figure on the receipt is derived from the real ideas — see the helpers. */

const POLL_MS = 30000;
const RATE = 0.55; // base $/word — the "list price"; each idea trades a bit above/below it
const STALE_MIN = 90; // minutes before the "synced" stamp goes amber (cron runs every 10 min)
let lastSig = null;
let lastSyncIso = null;

const $ = (sel) => document.querySelector(sel);
const money = (n) => "$" + n.toFixed(2);

// stable 32-bit hash of a string (FNV-1a) — same idea always gets the same number
function hash32(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// "market price" per word: every idea trades at a stable price seeded by its title,
// ranging 0.38–0.92 around the 0.55 list rate — so totals stop looking uniform.
function unitPrice(title) {
  const f = hash32(title) / 4294967295; // 0..1
  return Math.round((0.38 + f * 0.54) * 100) / 100;
}

// human "x ago" for the synced stamp
function agoText(iso) {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return { text: "synced --", stale: false };
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  let text;
  if (mins < 1) text = "synced just now";
  else if (mins < 60) text = `synced ${mins} min ago`;
  else if (mins < 1440) text = `synced ${Math.round(mins / 60)}h ago`;
  else text = `synced ${Math.round(mins / 1440)}d ago`;
  return { text, stale: mins >= STALE_MIN };
}

/* ---- user settings (persisted) ------------------------------------------- */
const DEFAULT_SETTINGS = {
  theme: "auto", sort: "default", sound: true, season: true, coupon: true, notify: false,
};
let settings = loadSettings();
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem("settings") || "{}")); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings() { localStorage.setItem("settings", JSON.stringify(settings)); }

// "theme" is the user's choice (auto/light/dark); the <html data-theme> attribute
// holds the *effective* value so the CSS only needs light/dark rules.
const prefersLight = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
function effectiveTheme() {
  if (settings.theme === "light" || settings.theme === "dark") return settings.theme;
  return prefersLight && prefersLight.matches ? "light" : "dark";
}
function applyTheme() { document.documentElement.dataset.theme = effectiveTheme(); }
prefersLight?.addEventListener?.("change", () => { if (settings.theme === "auto") applyTheme(); });
applyTheme();

/* ---- crossing ideas off (persisted per idea, keyed by title) ------------- */
const doneKey = (title) => "done:" + hash32(title);
const isDone = (title) => localStorage.getItem(doneKey(title)) === "1";
function toggleDone(title, el) {
  const now = !isDone(title);
  localStorage.setItem(doneKey(title), now ? "1" : "0");
  el.classList.toggle("done", now);
}

/* ---- sorting ------------------------------------------------------------- */
function sortItems(items) {
  const arr = items.slice();
  if (settings.sort === "new") arr.sort((a, b) => (Date.parse(b.added || "") || 0) - (Date.parse(a.added || "") || 0));
  else if (settings.sort === "price") arr.sort((a, b) => ideaWords(b) * unitPrice(b.title) - ideaWords(a) * unitPrice(a.title));
  else if (settings.sort === "az") arr.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return arr; // "default" keeps Notion order
}

/* ---- seasonal skin (auto by date) ---------------------------------------- */
const SEASON_KEYS = ["xmas", "newyear", "valentine", "halloween", "spring", "summer"];
function currentSeason() {
  const d = new Date(), m = d.getMonth() + 1, day = d.getDate();
  if (m === 12 && day >= 18) return { key: "xmas", badge: "🎄" };
  if (m === 1 && day <= 2) return { key: "newyear", badge: "🎉" };
  if (m === 2 && day >= 10 && day <= 15) return { key: "valentine", badge: "💘" };
  if (m === 10 && day >= 25) return { key: "halloween", badge: "🎃" };
  if ((m === 3 && day >= 15) || m === 4 || (m === 5 && day <= 15)) return { key: "spring", badge: "🌸" };
  if (m >= 6 && m <= 8) return { key: "summer", badge: "☀️" };
  return { key: "", badge: "" };
}
function applySeason() {
  const r = $("#receipt");
  if (!r) return;
  const s = settings.season ? currentSeason() : { key: "", badge: "" };
  SEASON_KEYS.forEach((k) => r.classList.remove("season-" + k));
  if (s.key) r.classList.add("season-" + s.key);
  const badge = $("#seasonBadge");
  if (badge) badge.textContent = s.badge;
}

/* ---- coupon (compact, optional, seeded by the day; tap to redeem) -------- */
function renderCoupon(when) {
  const el = $("#coupon");
  if (!el) return;
  if (!settings.coupon) { el.hidden = true; return; }
  el.hidden = false;
  const pct = 5 + (parseInt(when.ymd, 10) % 3) * 5;      // 5 / 10 / 15% — stable per day
  const code = "IDEA-" + when.ymd.slice(4) + when.hm;     // MMDDHHMM
  el.dataset.day = when.ymd;                              // redemption is per-day, not per-print
  el.dataset.label = `✁  SAVE ${pct}% ON YOUR NEXT IDEA  ·  ${code}`;
  setCouponState(el, localStorage.getItem("coupon:" + when.ymd) === "1");
}
function setCouponState(el, redeemed) {
  el.classList.toggle("redeemed", redeemed);
  el.textContent = redeemed ? "✓  REDEEMED — ENJOY YOUR IDEA" : (el.dataset.label || "");
}
$("#coupon")?.addEventListener("click", () => {
  const el = $("#coupon");
  const day = el.dataset.day;
  if (!day) return;
  const redeemed = localStorage.getItem("coupon:" + day) !== "1";
  localStorage.setItem("coupon:" + day, redeemed ? "1" : "0");
  setCouponState(el, redeemed);
});

/* ---- lifetime tally (only bumped on a genuine print) --------------------- */
function setLifetimeText(p) {
  const el = $("#lifetime");
  if (el) el.textContent = `${p} idea${p === 1 ? "" : "s"} printed here, all-time`;
}
function tallyLifetime(n) {
  const printed = (parseInt(localStorage.getItem("lifetimePrinted") || "0", 10) || 0) + n;
  localStorage.setItem("lifetimePrinted", String(printed));
  setLifetimeText(printed);
}

/* ---- real metrics -------------------------------------------------------- */
const wordsIn = (s) => (String(s || "").trim().match(/\S+/g) || []).length;
function ideaWords(it) {
  const details = Array.isArray(it.details) ? it.details : [];
  return wordsIn(it.title) + details.reduce((n, d) => n + wordsIn(d), 0);
}

function stamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  if (isNaN(d)) return { date: "--", time: "", ymd: "00000000", hm: "0000", year: "----" };
  const dd = p(d.getDate()), mm = p(d.getMonth() + 1), yyyy = d.getFullYear();
  const h24 = d.getHours();
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 < 12 ? "AM" : "PM";
  return {
    date: `${dd}/${mm}/${yyyy}`,                 // dd/mm/yyyy
    time: `${h12}:${p(d.getMinutes())} ${ampm}`, // 12-hour
    ymd: `${yyyy}${mm}${dd}`,
    hm: `${p(h24)}${p(d.getMinutes())}`,
    year: String(yyyy),
  };
}

// Rotating receipt slogans — a different one prints above the QR on every refresh.
const SLOGANS = [
  "thank you for thinking with us",
  "no refunds on big ideas",
  "today's special: your imagination",
  "ideas keep better when written down",
  "served fresh — zero preservatives",
  "every idea counts, literally",
  "warning: contents may inspire",
  "you're on a roll — keep going",
  "this receipt self-improves",
  "scan below to visit the source",
  "have a brilliant day",
  "come back with more ideas",
];
let sloganIdx = 0;

// Luhn check digit, so the printed serial is *valid* like a real product barcode.
function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = +num[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

// Serial encodes: print date (YYYYMMDD) · idea count (2) · word count (4) · check digit.
function serial(ymd, items, words) {
  const base = ymd
    + String(Math.min(items, 99)).padStart(2, "0")
    + String(Math.min(words, 9999)).padStart(4, "0");
  return base + luhn(base);
}
const group4 = (s) => s.replace(/(.{4})/g, "$1 ").trim();

/* ---- the scannable QR (real, encodes the Notion page URL) ----------------- */
function buildCode(url) {
  const el = $("#barcode");
  el.innerHTML = "";
  try {
    if (typeof qrcode !== "function" || !url) throw new Error("qr unavailable");
    const qr = qrcode(0, "M"); // type 0 = auto-size, error-correction M
    qr.addData(url);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    el.querySelector("svg rect")?.remove(); // drop the white background — sit on the paper
    el.classList.add("qr");
    return;
  } catch (e) {
    // Fallback: deterministic bars derived from the same url (no library available).
    el.classList.remove("qr");
    let h = 2166136261;
    const seed = url || "ideas";
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    for (let i = 0; i < 44; i++) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      const bar = document.createElement("i");
      bar.style.width = (1 + (h % 4)) + "px";
      bar.style.opacity = (h & 1) ? "1" : "0.16";
      el.appendChild(bar);
    }
  }
}

function render(data, animate) {
  const items = Array.isArray(data.items) ? data.items : [];
  const when = stamp(data.syncedAt);

  $("#store").textContent = (data.docTitle || "IDEA RECEIPT CO.").toUpperCase();
  $("#tagline").textContent = `est. ${when.year}`;
  $("#synced").textContent = `${when.date} ${when.time}`.trim();
  $("#order").textContent = `ORDER #${when.ymd.slice(4)}-${when.hm}`;
  lastSyncIso = data.syncedAt;
  updateSyncedAgo();
  applySeason();

  const merged = mergePending(items); // include ideas added here, awaiting next sync
  const list = $("#items");
  list.innerHTML = "";
  let subtotal = 0, totalWords = 0;

  sortItems(merged).forEach((it, i) => {
    const title = (it.title || "Untitled idea").trim();
    const details = Array.isArray(it.details) ? it.details : [];
    const words = ideaWords(it);
    const up = unitPrice(title);          // this idea's market rate per word
    const amt = words * up;               // price = words × this idea's going rate
    subtotal += amt;
    totalWords += words;

    const row = document.createElement("div");
    row.className = "item";
    if (isDone(title)) row.classList.add("done");
    if (it.pending) row.classList.add("pending");
    row.title = "tap to cross off";
    row.addEventListener("click", () => toggleDone(title, row));
    row.style.setProperty("--i", animate ? i : 0);

    const line = document.createElement("div");
    line.className = "item-line";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = title;
    const dots = document.createElement("span");
    dots.className = "dots";
    const amtEl = document.createElement("span");
    amtEl.className = "amt";
    amtEl.textContent = money(amt);
    line.append(name, dots, amtEl);
    row.appendChild(line);

    if (details.length) {
      const det = document.createElement("div");
      det.className = "details";
      details.forEach((d) => {
        const l = document.createElement("div");
        l.className = "detail";
        l.textContent = String(d).trim();
        det.appendChild(l);
      });
      row.appendChild(det);
    }

    const pts = details.length;
    const arrow = up > RATE ? " ▲" : up < RATE ? " ▼" : "";
    const added = it.added ? stamp(it.added) : null;
    const qty = document.createElement("div");
    qty.className = "qty";
    qty.textContent = it.pending
      ? "sending to Notion — prints on next sync"
      : `${words} word${words === 1 ? "" : "s"} @ ${money(up)}${arrow}`
        + (pts ? ` · ${pts} note${pts === 1 ? "" : "s"}` : "")
        + (added ? ` · ${added.date}` : "");
    row.appendChild(qty);

    list.appendChild(row);
  });

  if (!merged.length) {
    const empty = document.createElement("div");
    empty.className = "qty";
    empty.style.textAlign = "center";
    empty.textContent = "(no ideas yet — go jot one in Notion)";
    list.appendChild(empty);
  }

  const count = merged.length;
  const tax = subtotal * 0.18; // 18% brain tax on the subtotal
  $("#t-count").textContent = count;
  $("#t-words").textContent = totalWords;
  $("#t-subtotal").textContent = money(subtotal);
  $("#t-tax").textContent = money(tax);
  $("#t-total").textContent = count;
  $("#t-grand").textContent = money(subtotal + tax); // total price due

  $("#slogan").textContent = SLOGANS[sloganIdx % SLOGANS.length];
  sloganIdx++;

  renderCoupon(when);
  tallyLifetime(count); // bump the all-time printed count and update the footer line

  const url = data.docUrl || location.href;
  buildCode(url);
  const jot = $("#jot");
  if (jot) jot.href = url; // "jot a new idea" opens the Notion page itself
  $("#barnum").textContent = group4(serial(when.ymd, count, totalWords));
  let host = "this receipt";
  try { host = new URL(url).host.replace(/^www\./, ""); } catch (e) {}
  $("#barcap").textContent = `scan → ${host}`;

  if (animate) {
    const r = $("#receipt");
    r.classList.remove("printing");
    void r.offsetWidth; // restart animation
    r.classList.add("printing");
  }
}

async function pull(initial) {
  try {
    const res = await fetch("data.json?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    lastData = data;
    const sig = JSON.stringify(data);
    if (sig === lastSig) return; // nothing changed
    lastSig = sig;
    reconcileIdeas(data, initial); // clear synced pending ideas + alert on new ones
    render(data, !initial); // animate only on later refreshes; initial uses the CSS feed-in
    if (initial) {
      $("#items").querySelectorAll(".item").forEach((el, i) => el.style.setProperty("--i", i));
    }
  } catch (err) {
    if (initial) {
      $("#store").textContent = "RECEIPT UNAVAILABLE";
      $("#hint").textContent = "could not load data.json — serve this folder over http";
      console.error(err);
    }
  }
}

// editable "billed to" name, persisted on the device
function initBilled() {
  const el = $("#billed");
  if (!el) return;
  const saved = localStorage.getItem("billedTo");
  if (saved) el.textContent = saved;
  const edit = () => {
    const v = prompt("Billed to:", el.textContent.trim());
    if (v == null) return;
    const name = v.trim() || "—";
    el.textContent = name;
    localStorage.setItem("billedTo", name);
  };
  el.addEventListener("click", edit);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); }
  });
}
initBilled();

// keep the "synced x ago" line live (and amber once stale) without refetching
function updateSyncedAgo() {
  const el = $("#syncedAgo");
  if (!el) return;
  const { text, stale } = agoText(lastSyncIso);
  el.textContent = text;
  el.classList.toggle("stale", stale);
}
setInterval(updateSyncedAgo, 30000);

/* ---- save the receipt as a PNG image ------------------------------------- */
// Rasterise the receipt by inlining computed styles into an SVG <foreignObject>.
// No external libraries, no cross-origin assets, so the canvas stays untainted.
function inlineStyles(src, dst) {
  const cs = getComputedStyle(src);
  let str = "";
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    str += `${p}:${cs.getPropertyValue(p)};`;
  }
  dst.setAttribute("style", str);
  const sc = src.children, dc = dst.children;
  for (let i = 0; i < sc.length; i++) inlineStyles(sc[i], dc[i]);
}

async function saveImage() {
  const btn = $("#save");
  const src = $("#receipt");
  if (!src) return;
  try {
    if (btn) { btn.classList.add("busy"); btn.textContent = "rendering…"; }
    const rect = src.getBoundingClientRect();
    const w = Math.ceil(rect.width), h = Math.ceil(rect.height);

    const clone = src.cloneNode(true);
    // inline styles first — it walks src and clone in lockstep, so the trees must
    // still be structurally identical at this point.
    inlineStyles(src, clone);
    clone.querySelector("#sweep")?.remove();        // drop the animation overlay
    clone.classList.remove("printing");
    clone.querySelectorAll(".detail").forEach((d) => { d.textContent = "+ " + d.textContent; });
    clone.style.margin = "0";

    const xml = new XMLSerializer().serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">${xml}</div>` +
      `</foreignObject></svg>`;

    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0); resolve(); };
      img.onerror = reject;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });

    const fname = `idea-receipt-${stamp().ymd}.png`;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    // prefer the native share sheet on phones, fall back to a download
    if (blob && navigator.canShare && navigator.canShare({ files: [new File([blob], fname, { type: "image/png" })] })) {
      await navigator.share({ files: [new File([blob], fname, { type: "image/png" })], title: "Idea Receipt" });
    } else {
      const a = document.createElement("a");
      a.href = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
      a.download = fname;
      a.click();
      if (blob) setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  } catch (e) {
    console.error("save failed", e);
    if (btn) btn.textContent = "save failed";
    setTimeout(() => { if (btn) btn.textContent = "⬇ save image"; }, 1500);
    return;
  }
  if (btn) { btn.classList.remove("busy"); btn.textContent = "⬇ save image"; }
}
$("#save")?.addEventListener("click", saveImage);

// offline support: cache the shell + last ideas
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ---- adding ideas + live pending state ----------------------------------- */
let lastData = null;
const pendingIdeas = new Set(loadPending());
function loadPending() { try { return JSON.parse(localStorage.getItem("pendingIdeas") || "[]"); } catch (e) { return []; } }
function savePending() { localStorage.setItem("pendingIdeas", JSON.stringify([...pendingIdeas])); }

// fold ideas added here (but not yet synced back from Notion) into the rendered list
function mergePending(items) {
  const have = new Set(items.map((it) => (it.title || "").trim()));
  const extra = [...pendingIdeas]
    .filter((t) => !have.has(t))
    .map((t) => ({ title: t, details: [], added: new Date().toISOString(), pending: true }));
  return items.concat(extra);
}
function rerender() { if (lastData) render(lastData, false); }

// drop pending ideas that have now landed in Notion; alert on genuinely new ideas
function reconcileIdeas(data, initial) {
  const titles = new Set((data.items || []).map((it) => (it.title || "").trim()).filter(Boolean));
  let changed = false;
  for (const t of [...pendingIdeas]) if (titles.has(t)) { pendingIdeas.delete(t); changed = true; }
  if (changed) savePending();

  const known = getKnownTitles();
  if (known.size && !initial && settings.notify && "Notification" in window && Notification.permission === "granted") {
    const fresh = [...titles].filter((t) => !known.has(t));
    if (fresh.length) notify(`🧾 ${fresh.length} fresh idea${fresh.length > 1 ? "s" : ""} printed`, fresh.slice(0, 4).join(" · "));
  }
  setKnownTitles(titles);
}
function getKnownTitles() { try { return new Set(JSON.parse(localStorage.getItem("knownTitles") || "[]")); } catch (e) { return new Set(); } }
function setKnownTitles(set) { localStorage.setItem("knownTitles", JSON.stringify([...set])); }

async function notify(title, body) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg && reg.showNotification) reg.showNotification(title, { body, icon: "icon.png", badge: "icon.png", tag: "idea" });
    else new Notification(title, { body, icon: "icon.png" });
  } catch (e) { /* notifications unsupported — ignore */ }
}

/* ---- settings sheet ------------------------------------------------------ */
function openSheet() { syncSheet(); $("#sheet").hidden = false; }
function closeSheet() { $("#sheet").hidden = true; }
function syncSheet() {
  const set = (id, prop, val) => { const el = $(id); if (el) el[prop] = val; };
  set("#setTheme", "value", settings.theme);
  set("#setSort", "value", settings.sort);
  set("#setSound", "checked", settings.sound);
  set("#setSeason", "checked", settings.season);
  set("#setCoupon", "checked", settings.coupon);
  set("#setNotify", "checked", settings.notify);
}
$("#gear")?.addEventListener("click", openSheet);
$("#sheetClose")?.addEventListener("click", closeSheet);
$("#sheet")?.addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });

$("#setTheme")?.addEventListener("change", (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
$("#setSort")?.addEventListener("change", (e) => { settings.sort = e.target.value; saveSettings(); rerender(); });
$("#setSound")?.addEventListener("change", (e) => { settings.sound = e.target.checked; saveSettings(); });
$("#setSeason")?.addEventListener("change", (e) => { settings.season = e.target.checked; saveSettings(); applySeason(); });
$("#setCoupon")?.addEventListener("change", (e) => { settings.coupon = e.target.checked; saveSettings(); rerender(); });
$("#setNotify")?.addEventListener("change", async (e) => {
  if (e.target.checked) {
    if (!("Notification" in window)) { flashAdd("notifications aren't supported here"); e.target.checked = false; return; }
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm !== "granted") { e.target.checked = false; settings.notify = false; saveSettings(); flashAdd("notification permission was denied"); return; }
  }
  settings.notify = e.target.checked;
  saveSettings();
});

pull(true);
setInterval(() => pull(false), POLL_MS);

// pull fresh when the page is reopened / refocused on phone
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pull(false);
});

/* ---- printer sound + bing + haptics -------------------------------------- */
const PRINT_MS = 2400; // keep in sync with the CSS printout animation
let audioCtx = null;
function getCtx() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}

// A smooth thermal-printer feed: a soft pitched motor buzz (sawtooth through a bandpass)
// with a gentle pitch wobble and a steady tremolo for the mechanical "vvvvv" — no harsh
// random noise bursts. Eases in and out so it never clicks.
function playPrintSound(ms) {
  const ctx = getCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const dur = ms / 1000;

  // master envelope (keeps the level gentle and fades cleanly at both ends)
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.linearRampToValueAtTime(0.05, t0 + 0.08);
  master.gain.setValueAtTime(0.05, t0 + Math.max(0.08, dur - 0.1));
  master.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  master.connect(ctx.destination);

  // the feed tone: a sawtooth narrowed by a bandpass = a buzzy little motor
  const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 110;
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1200; bp.Q.value = 5;

  // slow wobble so the motor isn't perfectly static
  const wob = ctx.createOscillator(); wob.type = "sine"; wob.frequency.value = 5;
  const wobAmt = ctx.createGain(); wobAmt.gain.value = 5;
  wob.connect(wobAmt).connect(osc.frequency);

  // tremolo: fast AM gives the ratchety stepper feed, but smoothly (0.4–1.0 @ ~30Hz)
  const trem = ctx.createGain(); trem.gain.value = 0.7;
  const lfo = ctx.createOscillator(); lfo.type = "square"; lfo.frequency.value = 30;
  const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.3;
  lfo.connect(lfoDepth).connect(trem.gain);

  osc.connect(bp).connect(trem).connect(master);
  osc.start(t0); osc.stop(t0 + dur);
  wob.start(t0); wob.stop(t0 + dur);
  lfo.start(t0); lfo.stop(t0 + dur);
}

// A struck desk/service bell: bright metallic strike + inharmonic partials that ring out.
function playDing() {
  const ctx = getCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const f0 = 1280;
  // classic inharmonic bell ratios — gives the metallic "ting" rather than a pure tone
  [
    { r: 1.00, g: 0.24, d: 1.8 },
    { r: 2.76, g: 0.13, d: 1.4 },
    { r: 5.40, g: 0.08, d: 1.0 },
    { r: 8.93, g: 0.05, d: 0.7 },
  ].forEach(({ r, g, d }) => {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f0 * r;
    const ga = ctx.createGain();
    ga.gain.setValueAtTime(0.0001, t0);
    ga.gain.exponentialRampToValueAtTime(g, t0 + 0.003); // sharp strike attack
    ga.gain.exponentialRampToValueAtTime(0.0001, t0 + d); // long ring-out
    o.connect(ga).connect(ctx.destination);
    o.start(t0); o.stop(t0 + d + 0.05);
  });
  // the metallic "clink" of the hammer hitting the dome
  const nb = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.04), ctx.sampleRate);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
  const ns = ctx.createBufferSource(); ns.buffer = nb;
  const nf = ctx.createBiquadFilter(); nf.type = "highpass"; nf.frequency.value = 3200;
  const ng = ctx.createGain(); ng.gain.value = 0.18;
  ns.connect(nf).connect(ng).connect(ctx.destination);
  ns.start(t0); ns.stop(t0 + 0.04);
}

function printFx() {
  try {
    // print noise runs for the feed, then stops ~0.3s before the bell so the ding lands clean
    if (settings.sound) playPrintSound(PRINT_MS - 300);
    if (navigator.vibrate) {
      const pat = [];
      let total = 0;
      while (total < PRINT_MS - 140) { // ratchety feed, varied (Android; iOS Safari has no vibrate)
        const on = 16 + Math.floor(Math.random() * 16);
        const off = 14 + Math.floor(Math.random() * 20);
        pat.push(on, off);
        total += on + off;
      }
      pat.push(90); // final thunk
      navigator.vibrate(pat);
    }
    // the bell rings once the whole bill has printed out (after the print-out animation finishes)
    setTimeout(() => { if (settings.sound) playDing(); if (navigator.vibrate) navigator.vibrate(60); }, PRINT_MS + 60);
  } catch (e) { /* audio/haptics unsupported — ignore */ }
}

/* ---- manual refresh (home-screen app has no browser reload) --------------- */
let refreshing = false;
async function triggerRefresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("#reprint");
  if (btn) { btn.classList.add("busy"); btn.textContent = "↻ printing…"; }
  printFx(); // fires on the user gesture, so audio is allowed to play
  lastSig = null; // force a re-render (and the print animation) even if unchanged
  await pull(false);
  setTimeout(() => {
    refreshing = false;
    if (btn) { btn.classList.remove("busy"); btn.textContent = "↻ reprint"; }
  }, PRINT_MS);
}
$("#reprint")?.addEventListener("click", triggerRefresh);

// pull-to-refresh gesture (works in standalone mode where there's no browser UI)
let ptrStart = null;
window.addEventListener("touchstart", (e) => {
  ptrStart = window.scrollY <= 0 ? e.touches[0].clientY : null;
}, { passive: true });
window.addEventListener("touchmove", (e) => {
  if (ptrStart == null) return;
  const dy = e.touches[0].clientY - ptrStart;
  const ptr = $("#ptr");
  if (ptr && dy > 0 && window.scrollY <= 0) {
    ptr.style.opacity = Math.min(1, dy / 70);
    ptr.classList.toggle("ready", dy > 70);
    ptr.textContent = dy > 70 ? "↻ release to reprint" : "↓ pull to reprint";
  }
}, { passive: true });
window.addEventListener("touchend", () => {
  if (ptrStart == null) return;
  const ptr = $("#ptr");
  const ready = ptr && ptr.classList.contains("ready");
  if (ptr) { ptr.style.opacity = 0; ptr.classList.remove("ready"); }
  ptrStart = null;
  if (ready) triggerRefresh();
}, { passive: true });
