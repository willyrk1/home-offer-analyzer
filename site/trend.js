/* Local price trend from recorded sales: the subject's appraiser neighborhood, subdivision or
   ZIP, by 3-month window back from the "as of" date. Pure functions.
   Works in the browser (window.Trend) and in Node (module.exports).

   Two measures per window, both medians over market sales:
     $/sf              simple, but moves with the mix of houses that happened to sell
     price / just value  each sale over its parcel's current appraiser just value. Every parcel
                       carries the same year's just value, so this tracks price changes for the
                       same houses whatever the mix (homes remodeled since are the exception).
   Year-over-year compares the latest 6 months with the same 6 months a year earlier
   (CLAUDE.md invariant 6: seasonality). */
(function (root) {
  "use strict";

  const WINDOW = 3, WINDOWS = 8, YOY = 6, MIN_SALES = 10;
  const GROUPS = {
    nbhd: { label: "neighborhood", key: "nbhd" },
    subdivision: { label: "subdivision", key: "subdivision" },
    zip: { label: "ZIP", key: "zip" },
  };

  function addMonths(dateStr, n) {           // same month-end clamping as comps.js
    const [y, m, d] = dateStr.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }

  function median(xs) {
    if (!xs.length) return null;
    const v = [...xs].sort((a, b) => a - b), k = v.length >> 1;
    return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
  }

  /** Sales in (from, to]: count and medians. */
  function stats(sales, from, to) {
    const s = sales.filter((x) => x.date > from && x.date <= to);
    return {
      from, to, n: s.length,
      price: median(s.map((x) => x.price)),
      ppsf: median(s.filter((x) => x.sqft > 0).map((x) => x.price / x.sqft)),
      ratio: median(s.filter((x) => x.just_value > 0).map((x) => x.price / x.just_value)),
    };
  }

  const change = (a, b) => (a != null && b != null && b > 0 ? (a / b - 1) * 100 : null);

  /** ZIP Zillow index: the month of `dateStr` vs 12 months earlier, as %. */
  function zhviYoy(tindex, zip, dateStr) {
    const s = tindex && tindex[zip];
    if (!s || !s.length) return null;
    const at = (month) => { let v = null; for (const [m, x] of s) { if (m <= month) v = x; else break; } return v; };
    const month = dateStr.slice(0, 7), before = addMonths(dateStr, -12).slice(0, 7);
    return { pct: change(at(month), at(before)), month: s.filter(([m]) => m <= month).pop()?.[0] || null };
  }

  /** group: "nbhd" | "subdivision" | "zip". Returns windows newest first, yoy, and the group. */
  function local(subject, sales, asOf, group = "nbhd", tindex = null) {
    const g = GROUPS[group];
    const key = subject[g.key];
    const mine = sales.filter((s) => s.sale_class === "market" && s[g.key] === key);
    const windows = [];
    for (let k = 0; k < WINDOWS; k++)
      windows.push(stats(mine, addMonths(asOf, -WINDOW * (k + 1)), addMonths(asOf, -WINDOW * k)));
    const now = stats(mine, addMonths(asOf, -YOY), asOf);
    const before = stats(mine, addMonths(asOf, -12 - YOY), addMonths(asOf, -12));
    const enough = now.n >= MIN_SALES && before.n >= MIN_SALES;
    return {
      group, label: g.label, key, as_of: asOf, windows,
      yoy: { now, before, enough, ppsf_pct: change(now.ppsf, before.ppsf), ratio_pct: change(now.ratio, before.ratio) },
      zhvi: tindex ? zhviYoy(tindex, subject.zip, asOf) : null,
    };
  }

  const api = { GROUPS, MIN_SALES, WINDOW, YOY, local, median, addMonths };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Trend = api;
})(typeof window !== "undefined" ? window : globalThis);
