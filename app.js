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
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    ymd: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    hm: `${p(d.getHours())}${p(d.getMinutes())}`,
    year: String(d.getFullYear()),
  };
}

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
  $("#t-count").textContent = count;
  $("#t-words").textContent = totalWords;
  $("#t-subtotal").textContent = money(subtotal);
  $("#t-tax").textContent = money(subtotal * 0.18); // 18% brain tax on the subtotal
  $("#t-total").textContent = count;

  const url = data.docUrl || location.href;
  buildCode(url);
  $("#barnum").textContent = group4(serial(when.ymd, count, totalWords));
  let host = "this receipt";
  try { host = new URL(url).host.replace(/^www\./, ""); } catch (e) {}
  $("#barcap").textContent = `scan → ${host}`;

  if (animate) {
    const r = $("#receipt");
    r.classList.remove("reprint");
    void r.offsetWidth; // restart animation
    r.classList.add("reprint");
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

pull(true);
setInterval(() => pull(false), POLL_MS);

// pull fresh when the page is reopened / refocused on phone
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pull(false);
});

/* ---- manual refresh (home-screen app has no browser reload) --------------- */
let refreshing = false;
async function triggerRefresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("#reprint");
  if (btn) { btn.classList.add("busy"); btn.textContent = "↻ reprinting…"; }
  lastSig = null; // force a re-render (and the reprint animation) even if unchanged
  await pull(false);
  setTimeout(() => {
    refreshing = false;
    if (btn) { btn.classList.remove("busy"); btn.textContent = "↻ reprint receipt"; }
  }, 600);
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
