/* Redfin "recently sold" CSV -> extra comps, for sales that haven't reached county records yet.

   MLS data: it stays in the viewer's browser. Nothing here sends it anywhere, and it is
   never part of the published site or the repo (CLAUDE.md invariant 3).

   Each row is matched to a county parcel by address and ZIP, and the county's features
   are used (not Redfin's), so adjustments stay consistent with the county model. Rows
   are skipped, with a reason, when they aren't a sale, aren't a parcel we know, can't be
   pinned to one unit, or are already in county records (same parcel within DUP_DAYS).
   Works in the browser (window.Upload) and in Node (module.exports). */
(function (root) {
  "use strict";

  const Comps = root.Comps || (typeof require !== "undefined" ? require("./comps.js") : null);
  const DUP_DAYS = 45, DAY = 86400000;
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"];

  /** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF. Returns rows of strings. */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", q = false;
    const s = String(text).replace(/^﻿/, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
    return rows;
  }

  /** "September-15-2026", "Sep-15-2026", "2026-09-15" or "9/15/2026" -> "2026-09-15". */
  function isoDate(text) {
    const t = String(text || "").trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    m = t.match(/^([A-Za-z]+)[-\s](\d{1,2}),?[-\s](\d{4})$/);
    if (m) {
      const k = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
      if (k >= 0) return `${m[3]}-${String(k + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    return null;
  }

  const money = (v) => parseFloat(String(v || "").replace(/[$,\s]/g, ""));

  /** Redfin export -> {sales: [{line, address, zip, date, price, sqft, url}], skipped: [{line, address, reason}]} */
  function parseRedfin(text) {
    const rows = parseCSV(text);
    if (!rows.length) return { sales: [], skipped: [], error: "The file is empty." };
    const head = rows[0].map((h) => h.trim().toUpperCase());
    const col = (name) => head.findIndex((h) => h === name || h.startsWith(name));
    const c = { type: col("SALE TYPE"), date: col("SOLD DATE"), addr: col("ADDRESS"), zip: col("ZIP OR POSTAL CODE"),
      price: col("PRICE"), sqft: col("SQUARE FEET"), url: col("URL") };
    if (c.addr < 0 || c.price < 0 || c.date < 0) {
      return { sales: [], skipped: [], error: "This doesn't look like a Redfin download (no ADDRESS, PRICE and SOLD DATE columns)." };
    }
    const sales = [], skipped = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2, address = (r[c.addr] || "").trim();
      const get = (k) => (c[k] >= 0 ? (r[c[k]] || "").trim() : "");
      const date = isoDate(get("date")), price = money(get("price"));
      if (!price && /\bMLS\b|disclaimer/i.test(r.join(" "))) return;          // Redfin's "local MLS rules" footnote row
      if (c.type >= 0 && get("type") && !/sale/i.test(get("type"))) return skipped.push({ line, address, reason: "not a sale" });
      if (!date) return skipped.push({ line, address, reason: "no sold date (still for sale?)" });
      if (!(price >= 10000)) return skipped.push({ line, address, reason: "no usable price" });
      sales.push({ line, address, zip: (get("zip").match(/\d{5}/) || [null])[0], date, price,
        sqft: money(get("sqft")) || null, url: get("url") || null });
    });
    return { sales, skipped };
  }

  /** Index parcels by ZIP and normalized address: {zip: Map(key -> [parcel])}. */
  function indexParcels(parcelsByZip) {
    const out = {};
    for (const [zip, list] of Object.entries(parcelsByZip)) {
      const m = new Map();
      for (const p of list) {
        if (!p.address_key) continue;
        if (!m.has(p.address_key)) m.set(p.address_key, []);
        m.get(p.address_key).push(p);
      }
      out[zip] = m;
    }
    return out;
  }

  /** Parsed Redfin sales -> comp rows in the county sales layout, plus what was skipped and why.
      parcelIndex: indexParcels(...) for the ZIPs in the file; countySales: recorded sales rows. */
  function toComps(parsed, parcelIndex, countySales) {
    const added = [], skipped = [...parsed.skipped];
    const recorded = new Map();
    for (const s of countySales) {
      if (!["market", "distressed"].includes(s.sale_class)) continue;
      if (!recorded.has(s.parcel_id)) recorded.set(s.parcel_id, []);
      recorded.get(s.parcel_id).push(s);
    }
    const seen = new Set();
    for (const r of parsed.sales) {
      const skip = (reason) => skipped.push({ line: r.line, address: r.address, reason });
      if (!r.zip || !parcelIndex[r.zip]) { skip(r.zip ? `ZIP ${r.zip} isn't in this county's data` : "no ZIP"); continue; }
      const key = Comps.normalizeAddress(r.address.replace(/\s*#.*$/, ""));
      const hits = parcelIndex[r.zip].get(key) || [];
      if (!hits.length) { skip("no county parcel at this address"); continue; }
      if (hits.length > 1) { skip(`${hits.length} units share this address; can't tell which sold`); continue; }
      const p = hits[0];
      const when = Date.parse(r.date + "T00:00:00Z");
      const dup = (recorded.get(p.parcel_id) || []).find((s) => Math.abs(Date.parse(s.date + "T00:00:00Z") - when) <= DUP_DAYS * DAY);
      if (dup) { skip(`already in county records (${dup.date}, $${Math.round(dup.price).toLocaleString("en-US")})`); continue; }
      if (seen.has(p.parcel_id + r.date)) { skip("listed twice in the file"); continue; }
      seen.add(p.parcel_id + r.date);
      const sizeGap = r.sqft && p.sqft ? Math.abs(r.sqft / p.sqft - 1) : 0;
      added.push({
        parcel_id: p.parcel_id, address: p.address, zip: p.zip, date: r.date, price: r.price,
        sale_class: "market", reason: "", property_type: p.property_type, sqft: p.sqft, year_built: p.year_built,
        baths: p.baths, stories: p.stories, quality: p.quality, pool: p.pool, lot_acres: p.lot_acres, nbhd: p.nbhd,
        subdivision: p.subdivision, lat: p.lat, lon: p.lon, just_value: p.just_value,
        source: "redfin_upload", url: r.url,
        note: sizeGap > 0.2 ? `Redfin says ${Math.round(r.sqft).toLocaleString("en-US")} sq ft; county says ${Math.round(p.sqft).toLocaleString("en-US")}` : "",
      });
    }
    return { added, skipped };
  }

  const api = { parseCSV, isoDate, parseRedfin, indexParcels, toComps, DUP_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Upload = api;
})(typeof window !== "undefined" ? window : globalThis);
