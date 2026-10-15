/* Shared by the value page (value.js) and the every-number page (math.js), so both value a home
   from the same data with the same settings and land on the same number.
   - loading: county files, the subject, its sales, your Redfin file (this browser only)
   - settings in the link: method, range level, time adjustment, distressed sales, removed and added comps
   - which method and range the page shows
   Works in the browser (window.County) and in Node (module.exports; settings and choices only). */
(function (root) {
  "use strict";

  const COUNTY = "pasco";
  const BASE = `data/counties/${COUNTY}/`;
  const UPLOAD_KEY = "hoa:redfin:" + COUNTY;
  const DEFAULTS = { a: "", method: null, level: "80", time: "zip", includeDistressed: true, excluded: [], forced: [], focus: null };

  // ---------- settings <-> link (#a=...&m=blend&l=50&t=nbhd&d=0&x=id,id&f=id@date&c=id) ----------
  /** Only what differs from the defaults goes in the link, so a plain #a=<address> still works. */
  function encodeSettings(s) {
    const p = [["a", s.a]];
    if (s.method) p.push(["m", s.method]);
    if (s.level && s.level !== DEFAULTS.level) p.push(["l", s.level]);
    if (s.time && s.time !== DEFAULTS.time) p.push(["t", s.time]);
    if (s.includeDistressed === false) p.push(["d", "0"]);
    if (s.excluded && s.excluded.length) p.push(["x", s.excluded.join(",")]);
    if (s.forced && s.forced.length) p.push(["f", s.forced.map((f) => `${f.parcel_id}@${f.date}`).join(",")]);
    if (s.focus) p.push(["c", s.focus]);
    return "#" + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }

  function decodeSettings(hash) {
    const q = {};
    for (const part of String(hash || "").replace(/^#/, "").split("&")) {
      const i = part.indexOf("=");
      if (i > 0) q[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
    }
    const list = (v) => (v ? v.split(",").filter(Boolean) : []);
    return {
      a: q.a || "",
      method: q.m || null,
      level: q.l || DEFAULTS.level,
      time: q.t === "nbhd" ? "nbhd" : "zip",
      includeDistressed: q.d !== "0",
      excluded: list(q.x),
      forced: list(q.f).map((s) => { const [parcel_id, date] = s.split("@"); return { parcel_id, date }; }),
      focus: q.c || null,
    };
  }

  /** Added comps travel in the link as parcel@date; find the sales they stand for. */
  function findForced(refs, sales) {
    return refs.map((f) => sales.find((s) => s.parcel_id === f.parcel_id && s.date === f.date)).filter(Boolean);
  }

  // ---------- which method and range (same rules on both pages) ----------
  const bestMethod = (backtest) => (backtest && backtest.methods && backtest.methods.best) || "comps";

  /** The method you picked, else the backtest's most accurate, else comps (when a method can't value this home). */
  function pickMethod(r, wanted, backtest) {
    for (const m of [wanted, bestMethod(backtest), "comps"]) if (m && r.methods[m] && r.methods[m].fair_value != null) return m;
    return "comps";
  }

  /** The backtest's range calibration for a method, and the level to use (falls back to 80% if yours isn't fitted). */
  function calibration(backtest, method, level) {
    const cal = backtest && backtest.methods && backtest.methods.ranges && backtest.methods.ranges[method];
    if (!cal) return { cal: null, level };
    if (!cal.levels[level]) level = Object.keys(cal.levels).includes("80") ? "80" : Object.keys(cal.levels)[0];
    return { cal, level };
  }

  // ---------- loading (browser only) ----------
  const cache = new Map();
  function getJSON(path) {
    if (!cache.has(path)) {
      cache.set(path, fetch(BASE + path).then((r) => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }));
    }
    return cache.get(path);
  }

  async function loadCommon() {
    const [meta, model, tindex, streets, neighbors] = await Promise.all(
      ["meta.json", "model.json", "tindex.json", "streets.json", "neighbors.json"].map(getJSON));
    const [backtest, nbhdTrend] = await Promise.all(["backtest.json", "nbhd_trend.json"]
      .map((f) => getJSON(f).catch(() => null)));                         // optional
    return { meta, model, tindex, streets, neighbors, backtest, nbhdTrend };
  }

  async function findSubject(text, common) {
    const parsed = root.Comps.parseAddress(text);
    const zips = root.Comps.candidateZips(parsed, common.streets).filter((z) => common.meta.zips.includes(z));
    for (const z of zips) {
      const parcels = root.Comps.fromTable(await getJSON(`parcels/${z}.json`));
      const hit = parcels.find((p) => p.address_key === parsed.key);
      if (hit) return { subject: hit };
      if (z === zips[zips.length - 1]) {
        const num = parsed.key.split(" ")[0];
        return { similar: parcels.filter((p) => p.address_key.startsWith(num + " ")).slice(0, 5).map((p) => p.address) };
      }
    }
    return { similar: [], noStreet: true };
  }

  async function loadSales(zip, common) {
    const zips = common.neighbors[zip] || [zip];
    const tables = await Promise.all(zips.map((z) => getJSON(`sales/${z}.json`).catch(() => null)));
    return tables.filter(Boolean).flatMap(root.Comps.fromTable);
  }

  /** Your Redfin "recently sold" file as stored by the value page: {added, skipped, file, at} or null. */
  function readUploaded() {
    try { return JSON.parse(localStorage.getItem(UPLOAD_KEY)); } catch { return null; }
  }

  /** "As of" = the newest market sale, county-recorded or from your file (CLAUDE.md invariant 2). */
  function asOf(meta, added) {
    let d = meta ? meta.latest_sale : null;
    for (const s of added || []) if (!d || s.date > d) d = s.date;
    return d;
  }

  const api = { COUNTY, BASE, UPLOAD_KEY, DEFAULTS, encodeSettings, decodeSettings, findForced, bestMethod, pickMethod, calibration,
    getJSON, loadCommon, findSubject, loadSales, readUploaded, asOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.County = api;
})(typeof self !== "undefined" ? self : this);
