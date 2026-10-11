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
    const last = s.filter(([m]) => m <= dateStr.slice(0, 7)).pop();     // newest published month by then
    if (!last) return null;
    const before = addMonths(last[0] + "-01", -12).slice(0, 7);         // the same month a year earlier
    return { pct: change(last[1], at(before)), month: last[0] };
  }

  /** group: "nbhd" | "subdivision" | "zip". Returns windows newest first, yoy, and the group.
      match: optional test replacing "same group as the subject" (several neighborhood codes). */
  function local(subject, sales, asOf, group = "nbhd", tindex = null, match = null) {
    const g = GROUPS[group];
    const key = subject[g.key];
    const mine = sales.filter((s) => s.sale_class === "market" && (match ? match(s) : s[g.key] === key));
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

  // ---------- display (value page and the market page's neighborhood lookup) ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US");
  const pct = (v, d = 1) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
  const monthName = (ym) => ym ? new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "";
  const startMonth = (w) => monthName(addMonths(w.from, 1).slice(0, 7));

  function span(w) {
    const a = startMonth(w).split(" "), b = monthName(w.to.slice(0, 7)).split(" ");
    return a[1] === b[1] ? `${a[0]}–${b[0]} ${b[1]}` : `${a.join(" ")} – ${b.join(" ")}`;
  }

  /** Summary line, chart and table for a local() result. o: {name, zip, tindex, source} */
  function html(tr, o) {
    const y = tr.yoy;
    const head = y.enough
      ? `Last ${YOY} months vs the same months a year earlier: price ÷ just value <b>${pct(y.ratio_pct)}</b>, $/sf ${pct(y.ppsf_pct)} (${y.now.n} vs ${y.before.n} sales).`
      : `Too few sales for a year-over-year read (${y.now.n} in the last ${YOY} months, ${y.before.n} a year earlier; ${MIN_SALES} each needed).`;
    const z = tr.zhvi && tr.zhvi.pct != null ? ` For comparison, the Zillow index for ${esc(o.zip)}: ${pct(tr.zhvi.pct)} over the year to ${monthName(tr.zhvi.month)}.` : "";
    const label = tr.label[0].toUpperCase() + tr.label.slice(1);
    return `
    <p class="explain">${esc(label)}: ${esc(o.name)}. ${head}${z}</p>
    ${chart(tr, o)}
    <div class="table-scroll"><table class="trend-table">
      <thead><tr><th>Sold</th><th class="num">Sales</th><th class="num">Median price</th><th class="num">$/sf</th><th class="num">÷ just value</th></tr></thead>
      <tbody>${tr.windows.map((w) => `<tr${w.n < 5 ? ' class="thin"' : ""}><td>${span(w)}</td><td class="num">${w.n}</td><td class="num">${money(w.price)}</td>
        <td class="num">${w.ppsf == null ? "—" : "$" + Math.round(w.ppsf)}</td><td class="num">${w.ratio == null ? "—" : w.ratio.toFixed(3)}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="explain">${o.source || "Pasco Property Appraiser sales (market sales only)"} through ${esc(tr.as_of)}.
      Price ÷ just value compares each sale with that house's current appraiser value, so it follows prices for the same homes whatever mix sold;
      $/sf moves with the mix. Medians of a handful of sales jump around; faded rows have fewer than 5.
      Listings aren't published by neighborhood, so price cuts and inventory stay ZIP-level.</p>`;
  }

  /** Price ÷ just value by window vs the ZIP Zillow index, both = 100 at the oldest window with sales. */
  function chart(tr, o) {
    const ws = [...tr.windows].reverse();
    const zi = (o.tindex && o.tindex[o.zip]) || [];
    const at = (month) => { let v = null; for (const [m, x] of zi) { if (m <= month) v = x; else break; } return v; };
    const pts = ws.map((w, k) => ({ k, a: w.n >= 3 ? w.ratio : null, b: at(w.to.slice(0, 7)) }));
    const a0 = pts.find((p) => p.a != null);
    if (!a0 || pts.filter((p) => p.a != null).length < 3) return "";
    const base = a0.a, b0 = pts[a0.k].b;
    for (const p of pts) { p.a = p.a == null ? null : (p.a / base) * 100; p.b = p.b == null || !b0 || p.k < a0.k ? null : (p.b / b0) * 100; }
    const vals = pts.flatMap((p) => [p.a, p.b]).filter((v) => v != null);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.1, 1); lo -= pad; hi += pad;
    const W = 320, H = 150, L = 34, R = 8, T = 8, B = 20;
    const x = (k) => L + (k / (pts.length - 1)) * (W - L - R);
    const yy = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const line = (key) => pts.filter((p) => p[key] != null).map((p, i) => `${i ? "L" : "M"}${x(p.k).toFixed(1)},${yy(p[key]).toFixed(1)}`).join("");
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    return `<div class="chart trend-chart"><h3>Same-house prices vs the ZIP index <span class="explain">· 100 = ${startMonth(ws[a0.k])}</span></h3>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price over just value by quarter for the ${esc(tr.label)}, against the Zillow index for ${esc(o.zip)}">
      ${ticks.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${yy(t)}" y2="${yy(t)}"/><text class="axis" x="${L - 4}" y="${yy(t) + 3}" text-anchor="end">${Math.round(t)}</text>`).join("")}
      <path class="series" d="${line("a")}"/>
      ${pts.filter((p) => p.a != null).map((p) => `<circle class="dot" cx="${x(p.k).toFixed(1)}" cy="${yy(p.a).toFixed(1)}" r="2.5"/>`).join("")}
      <path class="series zip" d="${line("b")}"/>
      <text class="axis" x="${L}" y="${H - 4}">${startMonth(ws[0])}</text>
      <text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${monthName(ws[ws.length - 1].to.slice(0, 7))}</text>
    </svg>
    <div class="legend"><span class="key"></span> ${esc(tr.label)} sales, price ÷ just value <span class="key zip"></span> Zillow index, ${esc(o.zip)}</div></div>`;
  }

  // ---------- neighborhood lookup (nbhds.json: {code: {name, zips, parcels}}) ----------
  const words = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

  /** Neighborhoods matching typed text, merged by name (the appraiser reuses a name across codes).
      Every typed word must start a word of the name (any order), allowing one typo in words of 4+
      letters; a code typed exactly (CNWK) matches too. Biggest first. */
  function findNeighborhoods(text, nbhds, limit = 8) {
    const q = words(text);
    if (!q.length) return [];
    const byName = new Map();
    for (const [code, v] of Object.entries(nbhds)) {
      if (!v.name || !v.zips.length) continue;
      const k = v.name.toUpperCase();
      const e = byName.get(k) || { name: v.name, codes: [], zips: new Set(), parcels: 0 };
      e.codes.push(code); v.zips.forEach((z) => e.zips.add(z)); e.parcels += v.parcels;
      byName.set(k, e);
    }
    const hits = [];
    for (const e of byName.values()) {
      const nw = words(e.name);
      let cost = 0;
      const ok = q.every((w) => {
        if (q.length === 1 && e.codes.includes(w)) return true;
        if (nw.some((n) => n.startsWith(w))) return true;
        if (w.length >= 4 && nw.some((n) => typoPrefix(w, n))) { cost += 1; return true; }
        return false;
      });
      if (ok) hits.push({ ...e, zips: [...e.zips], cost });
    }
    return hits.sort((a, b) => a.cost - b.cost || b.parcels - a.parcels).slice(0, limit);
  }

  /** w is within one edit of the start of n (a typo in a partly typed word). */
  function typoPrefix(w, n) {
    for (const len of [w.length - 1, w.length, w.length + 1]) {
      if (len < 1 || len > n.length) continue;
      const p = n.slice(0, len);
      if (lev1(w, p)) return true;
    }
    return false;
  }

  function lev1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  const api = { GROUPS, MIN_SALES, WINDOW, YOY, local, median, addMonths, html, chart, findNeighborhoods, monthName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Trend = api;
})(typeof window !== "undefined" ? window : globalThis);
