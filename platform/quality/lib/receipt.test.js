// Unit tests for the pure receipt helpers.
//
// Runner: Vitest (`npm test`). The assertions use only `describe`/`it`/`expect`
// from "vitest". Everything under test is pure, so no DOM/jsdom is needed.

import { describe, it, expect } from "vitest";
import {
  RATE, STALE_MIN, money, hash32, unitPrice, agoText, wordsIn, ideaWords,
  stamp, luhn, serial, group4, longestStreak, sparkline, parseHeading,
} from "./receipt.js";

describe("money", () => {
  it("formats with two decimals and a $ sign", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(1.5)).toBe("$1.50");
    expect(money(12.345)).toBe("$12.35"); // toFixed rounds
  });
});

describe("hash32 (FNV-1a)", () => {
  it("is deterministic and unsigned 32-bit", () => {
    const h = hash32("3D Printed Lamps");
    expect(h).toBe(hash32("3D Printed Lamps"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
  it("differs for different inputs and coerces non-strings", () => {
    expect(hash32("a")).not.toBe(hash32("b"));
    expect(hash32(123)).toBe(hash32("123"));
  });
  it("matches a known FNV-1a vector", () => {
    // FNV-1a 32-bit of "" is the offset basis 2166136261
    expect(hash32("")).toBe(2166136261);
  });
});

describe("unitPrice", () => {
  it("is stable per title and within the documented 0.38–0.92 band", () => {
    for (const t of ["Shower Speaker", "Claude Reminder", "x", "", "💡 idea"]) {
      const p = unitPrice(t);
      expect(p).toBe(unitPrice(t));
      expect(p).toBeGreaterThanOrEqual(0.38);
      expect(p).toBeLessThanOrEqual(0.92);
      // rounded to cents
      expect(Math.round(p * 100)).toBe(p * 100);
    }
  });
});

describe("agoText", () => {
  const base = Date.parse("2026-06-27T12:00:00Z");
  it("handles invalid / empty iso", () => {
    expect(agoText("", base)).toEqual({ text: "synced --", stale: false });
    expect(agoText("not-a-date", base)).toEqual({ text: "synced --", stale: false });
  });
  it("renders minute/hour/day buckets", () => {
    expect(agoText("2026-06-27T11:59:40Z", base).text).toBe("synced just now");
    expect(agoText("2026-06-27T11:30:00Z", base).text).toBe("synced 30 min ago");
    expect(agoText("2026-06-27T09:00:00Z", base).text).toBe("synced 3h ago");
    expect(agoText("2026-06-25T12:00:00Z", base).text).toBe("synced 2d ago");
  });
  it("goes stale at STALE_MIN minutes", () => {
    const justUnder = new Date(base - (STALE_MIN - 1) * 60000).toISOString();
    const atLimit = new Date(base - STALE_MIN * 60000).toISOString();
    expect(agoText(justUnder, base).stale).toBe(false);
    expect(agoText(atLimit, base).stale).toBe(true);
  });
  it("clamps future timestamps to 'just now'", () => {
    expect(agoText("2026-06-27T12:05:00Z", base).text).toBe("synced just now");
  });
});

describe("wordsIn / ideaWords", () => {
  it("counts whitespace-delimited tokens", () => {
    expect(wordsIn("")).toBe(0);
    expect(wordsIn("   ")).toBe(0);
    expect(wordsIn("one")).toBe(1);
    expect(wordsIn("  two   words ")).toBe(2);
    expect(wordsIn(null)).toBe(0);
  });
  it("sums title + details, tolerating missing details", () => {
    expect(ideaWords({ title: "Shower Speaker" })).toBe(2);
    expect(ideaWords({ title: "Shower Speaker", details: ["a b", "c"] })).toBe(2 + 2 + 1);
    expect(ideaWords({ title: "x", details: "not an array" })).toBe(1);
  });
});

describe("stamp", () => {
  it("formats a known UTC-ish instant into dd/mm/yyyy parts", () => {
    // Use an explicit local-time-bearing ISO to avoid TZ ambiguity in assertions
    // that depend on the calendar day; check the structural invariants instead.
    const s = stamp("2026-03-05T13:07:00");
    expect(s.date).toBe("05/03/2026");
    expect(s.ymd).toBe("20260305");
    expect(s.hm).toBe("1307");
    expect(s.time).toBe("1:07 PM");
    expect(s.year).toBe("2026");
  });
  it("midnight is 12 AM, noon is 12 PM", () => {
    expect(stamp("2026-01-01T00:00:00").time).toBe("12:00 AM");
    expect(stamp("2026-01-01T12:00:00").time).toBe("12:00 PM");
  });
  it("returns sentinel parts for an invalid date", () => {
    expect(stamp("garbage")).toEqual({
      date: "--", time: "", ymd: "00000000", hm: "0000", year: "----",
    });
  });
});

describe("luhn", () => {
  it("produces the check digit that validates the full number", () => {
    // appending the digit makes the whole string pass a standard Luhn check
    const body = "20260627030042";
    const full = body + luhn(body);
    expect(luhnValid(full)).toBe(true);
  });
  it("is a single digit", () => {
    expect(luhn("7992739871")).toMatch(/^[0-9]$/);
  });
  // local reference Luhn validator (independent of the impl under test)
  function luhnValid(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let n = +s[i];
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }
});

describe("serial", () => {
  it("encodes date+count+words and ends in a valid check digit", () => {
    const s = serial("20260627", 3, 42);
    expect(s).toBe("20260627" + "03" + "0042" + luhn("20260627030042"));
    expect(s).toHaveLength(15);
  });
  it("clamps count to 99 and words to 9999", () => {
    const s = serial("20260627", 1000, 100000);
    expect(s.slice(8, 10)).toBe("99");
    expect(s.slice(10, 14)).toBe("9999");
  });
});

describe("group4", () => {
  it("groups characters in blocks of four", () => {
    expect(group4("202606270300429")).toBe("2026 0627 0300 429");
    expect(group4("12345678")).toBe("1234 5678");
  });
});

describe("longestStreak", () => {
  it("is 0 for empty history", () => {
    expect(longestStreak([])).toBe(0);
  });
  it("counts the longest run of consecutive days, dedup + unordered safe", () => {
    const hist = [
      { ymd: "20260610" }, { ymd: "20260611" }, { ymd: "20260612" }, // run of 3
      { ymd: "20260614" },                                            // gap
      { ymd: "20260101" }, { ymd: "20260101" },                       // dup
    ];
    expect(longestStreak(hist)).toBe(3);
  });
  it("handles a single day", () => {
    expect(longestStreak([{ ymd: "20260101" }])).toBe(1);
  });
});

describe("sparkline", () => {
  it("returns empty string for fewer than two points", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([5])).toBe("");
  });
  it("emits an svg polyline with one point per value", () => {
    const svg = sparkline([1, 3, 2, 5]);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<polyline");
    const pts = svg.match(/points="([^"]*)"/)[1].trim().split(/\s+/);
    expect(pts).toHaveLength(4);
  });
});

describe("parseHeading (Notion #tag rule, parity with sync_notion.py)", () => {
  it("extracts hashtags and strips them from the title", () => {
    expect(parseHeading("Shower Speaker #hardware #fun")).toEqual({
      title: "Shower Speaker", tags: ["hardware", "fun"],
    });
  });
  it("returns no tags when there are none", () => {
    expect(parseHeading("3D Printed Lamps")).toEqual({
      title: "3D Printed Lamps", tags: [],
    });
  });
  it("strips a trailing colon (toggle-heading style)", () => {
    expect(parseHeading("Claude Reminder:")).toEqual({
      title: "Claude Reminder", tags: [],
    });
  });
  it("keeps hyphenated tags and allows leading-digit tag bodies", () => {
    expect(parseHeading("App #side-project #v2")).toEqual({
      title: "App", tags: ["side-project", "v2"],
    });
  });
  it("falls back to raw when the heading is only tags", () => {
    // mirrors `title = ... or raw` in sync_notion.py
    const r = parseHeading("#idea");
    expect(r.tags).toEqual(["idea"]);
    expect(r.title).toBe("#idea");
  });
  it("tolerates null/empty", () => {
    expect(parseHeading("")).toEqual({ title: "", tags: [] });
    expect(parseHeading(null)).toEqual({ title: "", tags: [] });
  });
});
