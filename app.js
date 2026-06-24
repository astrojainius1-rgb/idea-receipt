/* Idea Receipt — renders data.json as a shop receipt and polls for changes.
   Every figure on the receipt is derived from the real ideas — see the helpers. */

const POLL_MS = 30000;
const RATE = 0.55; // $ per word — the receipt "prices" your thinking at 55¢ a word
let lastSig = null;

const $ = (sel) => document.querySelector(sel);
const money = (n) => "$" + n.toFixed(2);

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
  return {
    date: `${dd}/${mm}/${yyyy}`,                 // dd/mm/yyyy
    time: `${p(d.getHours())}:${p(d.getMinutes())}`, // 24-hour
    ymd: `${yyyy}${mm}${dd}`,
    hm: `${p(d.getHours())}${p(d.getMinutes())}`,
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
  $("#tagline").textContent = `est. ${when.year} — ideas, freshly printed`;
  $("#synced").textContent = `${when.date} ${when.time}`.trim();
  $("#order").textContent = `ORDER #${when.ymd}-${when.hm}`;

  const list = $("#items");
  list.innerHTML = "";
  let subtotal = 0, totalWords = 0;

  items.forEach((it, i) => {
    const title = (it.title || "Untitled idea").trim();
    const details = Array.isArray(it.details) ? it.details : [];
    const words = ideaWords(it);
    const amt = words * RATE; // price = the words you spent on the idea
    subtotal += amt;
    totalWords += words;

    const row = document.createElement("div");
    row.className = "item";
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
    const qty = document.createElement("div");
    qty.className = "qty";
    qty.textContent =
      `${words} word${words === 1 ? "" : "s"} @ ${money(RATE)}`
      + (pts ? ` · ${pts} note${pts === 1 ? "" : "s"}` : "");
    row.appendChild(qty);

    list.appendChild(row);
  });

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "qty";
    empty.style.textAlign = "center";
    empty.textContent = "(no ideas yet — go jot one in Notion)";
    list.appendChild(empty);
  }

  const count = items.length;
  const tax = subtotal * 0.18; // 18% brain tax on the subtotal
  $("#t-count").textContent = count;
  $("#t-words").textContent = totalWords;
  $("#t-subtotal").textContent = money(subtotal);
  $("#t-tax").textContent = money(tax);
  $("#t-total").textContent = count;
  $("#t-grand").textContent = money(subtotal + tax); // total price due

  $("#slogan").textContent = SLOGANS[sloganIdx % SLOGANS.length];
  sloganIdx++;

  const url = data.docUrl || location.href;
  buildCode(url);
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
    const sig = JSON.stringify(data);
    if (sig === lastSig) return; // nothing changed
    lastSig = sig;
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

// A real-printer feel: a wobbling motor hum + ratchety head grains whose timing,
// loudness and pitch vary, with occasional carriage-return pauses between "lines".
function playPrintSound(ms) {
  const ctx = getCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const dur = ms / 1000;

  // motor hum underneath, speed wobbling slightly
  const motor = ctx.createOscillator(); motor.type = "sawtooth";
  const motorGain = ctx.createGain();
  const motorLp = ctx.createBiquadFilter(); motorLp.type = "lowpass"; motorLp.frequency.value = 240;
  motorGain.gain.setValueAtTime(0.0001, t0);
  motorGain.gain.linearRampToValueAtTime(0.035, t0 + 0.1);
  let mt = 0;
  while (mt < dur) {
    motor.frequency.setValueAtTime(50 + Math.random() * 16, t0 + mt);
    mt += 0.07 + Math.random() * 0.07;
  }
  motorGain.gain.setValueAtTime(0.035, t0 + Math.max(0, dur - 0.12));
  motorGain.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  motor.connect(motorLp).connect(motorGain).connect(ctx.destination);
  motor.start(t0); motor.stop(t0 + dur);

  // ratchety print head: bursts of filtered noise, jittered in time/level/pitch
  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * dur)), ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.2;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);

  let t = 0, line = 0;
  const lineLen = 7 + Math.floor(Math.random() * 7);
  while (t < dur) {
    const onset = t0 + t;
    const len = 0.016 + Math.random() * 0.03;     // burst length varies
    const amp = 0.05 + Math.random() * 0.13;       // loudness varies
    gain.gain.setValueAtTime(amp, onset);
    gain.gain.exponentialRampToValueAtTime(0.008, onset + len * 0.75);
    bp.frequency.setValueAtTime(850 + Math.random() * 2300, onset); // pitch/timbre varies
    t += len + 0.004 + Math.random() * 0.01;
    if (++line % lineLen === 0) t += 0.07 + Math.random() * 0.1;     // carriage-return pause
  }
  gain.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(gain).connect(ctx.destination);
  src.start(t0); src.stop(t0 + dur);
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
    playPrintSound(PRINT_MS - 140);
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
    setTimeout(() => { playDing(); if (navigator.vibrate) navigator.vibrate(60); }, PRINT_MS - 40);
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
    if (btn) { btn.classList.remove("busy"); btn.textContent = "↻ reprint receipt"; }
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
