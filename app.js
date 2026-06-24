/* Idea Receipt — renders data.json as a shop receipt and polls for changes. */

const POLL_MS = 30000;
let lastSig = null;

const $ = (sel) => document.querySelector(sel);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function priceFor(seed) {
  const cents = 100 + (hashStr("$" + seed) % 900); // $1.00 .. $9.99
  return cents / 100;
}

const money = (n) => "$" + n.toFixed(2);

function fmtWhen(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d)) return "--";
  const date = d.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function buildBarcode(seed) {
  const el = $("#barcode");
  el.innerHTML = "";
  let h = hashStr(seed || "ideas");
  // deterministic pseudo-random bar widths from the hash
  for (let i = 0; i < 44; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    const w = 1 + (h % 4); // 1..4 px
    const bar = document.createElement("i");
    bar.style.width = w + "px";
    bar.style.opacity = (h & 1) ? "1" : "0.16"; // gaps as faint bars keep spacing even
    el.appendChild(bar);
  }
}

function digitsFrom(seed) {
  const h = hashStr("#" + (seed || "ideas")).toString().padStart(10, "0").slice(0, 12).padEnd(12, "0");
  return `${h.slice(0, 4)} ${h.slice(4, 8)} ${h.slice(8, 12)}`;
}

function render(data, animate) {
  const items = Array.isArray(data.items) ? data.items : [];

  $("#store").textContent = (data.docTitle || "IDEA RECEIPT CO.").toUpperCase();
  $("#synced").textContent = fmtWhen(data.syncedAt);
  $("#order").textContent = "ORDER #" + String(hashStr(data.syncedAt || "") % 10000).padStart(4, "0");

  const list = $("#items");
  list.innerHTML = "";
  let subtotal = 0;

  items.forEach((it, i) => {
    const title = (it.title || "Untitled idea").trim();
    const details = Array.isArray(it.details) ? it.details : [];
    const p = priceFor(title);
    subtotal += p;

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
    const amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = money(p);
    line.append(name, dots, amt);
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

    const qty = document.createElement("div");
    qty.className = "qty";
    qty.textContent = `qty ${Math.max(1, details.length)} @ ${money(p)}`;
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

  const count = (data.count != null) ? data.count : items.length;
  $("#t-count").textContent = count;
  $("#t-subtotal").textContent = money(subtotal);
  $("#t-total").textContent = count;

  buildBarcode(data.docTitle);
  $("#barnum").textContent = digitsFrom(data.docTitle);

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
      // initial render still wants the staggered feed-in
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
