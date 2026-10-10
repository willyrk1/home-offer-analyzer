/* Comps engine for the browser. Mirrors pipeline/comps.py and pipeline/valuation.py;
   tests/test_comps_js.py checks both give the same answer on the same data.
   Works in the browser (window.Comps) and in Node (module.exports). */
(function (root) {
  "use strict";

  const MIN_COMPS = 6, MAX_COMPS = 8;
  const SEARCH = [[0.5, 6], [1.0, 6], [1.0, 9], [2.0, 9], [2.0, 12], [3.0, 12], [5.0, 18]];
  const DISTRESSED_WEIGHT = 0.5, NET_LIMIT = 15, GROSS_LIMIT = 25, SIZE_LIMIT = 0.35;
  // Similarity penalty per unit of difference; same table as SIM in pipeline/comps.py.
  const SIM = { size: 1.0, age: 0.6, lot: 0.3, baths: 0.4, pool: 1.0, dist: 0.8, months: 0.5,
    same_nbhd: 0.3, same_subdivision: 0.4 };
  const METHODS = ["comps", "assessed", "blend"];
  const JV_MIN_COMPS = 3, JV_RATIO_BAND = 1.5, JV_SUBJECT_MIN = 0.6;   // as in pipeline/comps.py
  const FEATURES = ["ln_sqft", "age", "new", "ln_lot", "baths", "pool", "two_story", "quality"];
  const DAY = 86400000;

  // ---------- small helpers ----------
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const num = (v, d) => (isNum(v) ? v : d);
  const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const ymd = (d) => d.toISOString().slice(0, 10);
  function addMonths(d, n) {            // pandas DateOffset(months=n): clamp to month end
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    const target = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last)));
  }
  function dayOfYear(d) { return Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1; }
  function middle(xs) {                  // comps._median
    const v = xs.slice().sort((a, b) => a - b), k = Math.floor(v.length / 2);
    return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
  }
  function median(xs) {
    const v = xs.filter(isNum).sort((a, b) => a - b);
    if (!v.length) return 2;
    const k = Math.floor(v.length / 2);
    return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(a));
  }
  function fromTable(t) {
    return t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
  }

  // ---------- addresses ----------
  const SUFFIX = { RD: "ROAD", DR: "DRIVE", LN: "LANE", AVE: "AVENUE", AV: "AVENUE", ST: "STREET", CT: "COURT",
    WAY: "WAY", LOOP: "LOOP", BLVD: "BOULEVARD", CIR: "CIRCLE", PL: "PLACE", TRL: "TRAIL", TER: "TERRACE",
    PKWY: "PARKWAY", PT: "POINT", CV: "COVE", SQ: "SQUARE", HWY: "HIGHWAY", PATH: "PATH", RUN: "RUN",
    BND: "BEND", PASS: "PASS", TRCE: "TRACE", XING: "CROSSING", RDG: "RIDGE", HTS: "HEIGHTS" };
  function normalizeAddress(text) {             // same rules as pasco.normalize_address
    let t = String(text).toUpperCase().replace(/[^\w\s]/g, " ");
    t = t.replace(/\b(APT|UNIT|STE|SUITE)\b.*$/, "");
    const w = t.split(/\s+/).filter(Boolean);
    if (w.length && ["N", "S", "E", "W", "NE", "NW", "SE", "SW"].includes(w[w.length - 1])) w.pop();
    if (w.length && SUFFIX[w[w.length - 1]]) w[w.length - 1] = SUFFIX[w[w.length - 1]];
    return w.join(" ");
  }
  /** "1295 Montgomery Bell Rd, Wesley Chapel, FL 33543" -> {key, zip} */
  function parseAddress(text) {
    const zip = (String(text).match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || null;
    return { key: normalizeAddress(String(text).split(",")[0]), zip };
  }

  /** ZIP files to search for an address: the ZIP typed (if any), then every ZIP the street is in. */
  function candidateZips(parsed, streets) {
    const street = parsed.key.split(" ").slice(1).join(" ");
    const out = parsed.zip ? [parsed.zip] : [];
    for (const z of streets[street] || []) if (!out.includes(z)) out.push(z);
    return out;
  }

  // ---------- model features (valuation.design) ----------
  function design(rows, asOfYear) {
    const med = median(rows.map((r) => r.baths));
    return rows.map((r) => {
      const year = asOfYear != null ? asOfYear : parseDate(r.date).getUTCFullYear();
      const age = clip(year - r.year_built, 0, 100);
      return {
        ln_sqft: Math.log(Math.max(r.sqft, 300)),
        age,
        new: age <= 2 ? 1 : 0,
        ln_lot: Math.log(clip(num(r.lot_acres, 0.15), 0.02, 5.0)),
        baths: clip(num(r.baths, med), 0.5, 8),
        pool: r.pool ? 1 : 0,
        two_story: num(r.stories, 1) >= 2 ? 1 : 0,
        quality: clip(num(r.quality, 4), 1, 6),
      };
    });
  }

  // ---------- time index ----------
  function timeFactor(tindex, zip, dateStr) {
    const s = tindex[zip];
    if (!s || !s.length) return [1.0, "no index for ZIP"];
    const month = dateStr.slice(0, 7);
    let then = null;
    for (const [m, v] of s) { if (m <= month) then = v; else break; }
    if (!then) return [1.0, "no index for month"];
    const [lm, lv] = s[s.length - 1];
    return [lv / then, `${month} -> ${lm}`];
  }

  // ---------- similarity (comps._similarity) ----------
  function similarity(c, subj, asOf) {
    const subjLot = num(subj.lot_acres, 0.15);
    const subjBaths = num(subj.baths, 2.0);
    const parts = {
      size: Math.abs(Math.log(c.sqft / subj.sqft)) / 0.15,
      age: Math.abs(num(c.year_built, subj.year_built) - subj.year_built) / 10,
      lot: Math.abs(Math.log(Math.max(num(c.lot_acres, subjLot), 0.02) / Math.max(subjLot, 0.02))) / 0.5,
      baths: Math.abs(num(c.baths, subjBaths) - subjBaths),
      pool: (Boolean(c.pool) !== Boolean(subj.pool)) ? 0.5 : 0,
      dist: c.distance_mi,
      months: Math.round((asOf - parseDate(c.date)) / DAY) / 30.4 / 6,
    };
    let penalty = SIM.size * parts.size + SIM.age * parts.age + SIM.lot * parts.lot + SIM.baths * parts.baths +
      SIM.pool * parts.pool + SIM.dist * parts.dist + SIM.months * parts.months;
    penalty -= SIM.same_nbhd * (c.nbhd === subj.nbhd ? 1 : 0) + SIM.same_subdivision * (c.subdivision === subj.subdivision ? 1 : 0);
    return { score: 1 / (1 + Math.max(penalty, 0)), parts };
  }

  // ---------- adjustments (comps.adjust) ----------
  function adjust(c, subjX, compX, model, tindex) {
    const [tf, tnote] = timeFactor(tindex, c.zip, c.date);
    const base = c.price * tf;
    const lines = [];
    let logSum = 0, gross = 0;
    for (const f of FEATURES) {
      const b = model.features[f].coef;
      const d = subjX[f] - compX[f];
      if (Math.abs(d) < 1e-9 || !isFinite(b)) continue;
      const pct = Math.expm1(b * d);
      logSum += b * d;
      gross += Math.abs(pct);
      lines.push({ feature: f, label: model.features[f].label, coef: b, difference: d,
        pct: pct * 100, dollars: base * pct });
    }
    return { time_factor: tf, time_note: tnote, time_adjusted: base, adjustments: lines,
      adjusted_price: base * Math.exp(logSum), net_pct: Math.expm1(logSum) * 100, gross_pct: gross * 100 };
  }

  // ---------- candidate pool ----------
  function buildPool(subject, sales, opts) {
    const excluded = new Set(opts.excluded || []);
    const classes = opts.includeDistressed === false ? ["market"] : ["market", "distressed"];
    const latest = new Map();
    for (const s of sales) {
      if (s.property_type !== subject.property_type) continue;
      if (!classes.includes(s.sale_class)) continue;
      if (s.parcel_id === subject.parcel_id || excluded.has(s.parcel_id)) continue;
      if (opts.asOf && s.date > opts.asOf) continue;    // no-op live; matters in backtests
      const prev = latest.get(s.parcel_id);
      if (!prev || s.date >= prev.date) latest.set(s.parcel_id, s);
    }
    return [...latest.values()];
  }

  function withDistance(pool, subject, located) {
    return pool.map((s) => ({ ...s, distance_mi: located
      ? haversine(subject.lat, subject.lon, s.lat, s.lon)
      : (s.subdivision === subject.subdivision ? 0.25 : s.nbhd === subject.nbhd ? 0.75 : 1.5) }));
  }

  function searchSteps(subject, located) {
    if (located) return SEARCH.map(([r, m]) => ({ label: `within ${r} mi`, test: (s) => s.distance_mi <= r, months: m }));
    const areas = [["subdivision", (s) => s.subdivision === subject.subdivision],
      ["neighborhood", (s) => s.nbhd === subject.nbhd], ["ZIP", (s) => s.zip === subject.zip]];
    return areas.flatMap(([label, test]) => [6, 12, 18].map((m) => ({ label: `same ${label}`, test, months: m })));
  }

  const inSize = (s, subject) => Math.abs(Math.log(s.sqft / subject.sqft)) <= SIZE_LIMIT;

  /** Value a subject. opts: {asOf, includeDistressed, excluded: [parcel_id], forced: [sale rows]} */
  function valueSubject(subject, sales, model, tindex, opts = {}) {
    const asOf = parseDate(opts.asOf);
    let pool = buildPool(subject, sales, opts);
    const located = isNum(subject.lat) && pool.some((s) => isNum(s.lat));
    if (located) pool = pool.filter((s) => isNum(s.lat));
    pool = withDistance(pool, subject, located);

    let chosen = [], reach = null;
    for (const step of searchSteps(subject, located)) {
      const cutoff = addMonths(asOf, -step.months);
      chosen = pool.filter((s) => step.test(s) && parseDate(s.date) > cutoff && inSize(s, subject));
      reach = { area: step.label, months: step.months, located };
      if (chosen.length >= MIN_COMPS) break;
    }
    if (chosen.length < MIN_COMPS) reach.thin = true;

    chosen = chosen.map((c) => { const sim = similarity(c, subject, asOf); return { ...c, similarity: sim.score, sim_parts: sim.parts }; });
    chosen.sort((a, b) => b.similarity - a.similarity);
    chosen = chosen.slice(0, MAX_COMPS);

    for (const f of opts.forced || []) {
      if (chosen.some((c) => c.parcel_id === f.parcel_id)) continue;
      const [withD] = withDistance([f], subject, located && isNum(f.lat));
      const sim = similarity(withD, subject, asOf);
      chosen.push({ ...withD, similarity: sim.score, sim_parts: sim.parts, forced: true });
    }
    return finish(subject, chosen, model, tindex, asOf, reach, pool);
  }

  // ---------- other ways to turn comps into a value (comps.assessed_value / combine_methods) ----------
  function assessedValue(subject, comps) {
    const jv = num(subject.just_value, NaN), sqft = num(subject.sqft, NaN);
    const none = (reason) => ({ fair_value: null, range: null, reason });
    const usable = comps.filter((c) => isNum(c.just_value) && c.just_value > 0);
    if (!(jv > 0) || usable.length < JV_MIN_COMPS) return none("not enough comps with an appraiser value");
    const ratio = (c) => c.time_adjusted / c.just_value;
    const med = middle(usable.map(ratio));
    const kept = usable.filter((c) => med / JV_RATIO_BAND <= ratio(c) && ratio(c) <= med * JV_RATIO_BAND);
    if (kept.length < JV_MIN_COMPS) return none("comps' ratios disagree too much");
    const jvPsf = middle(kept.map((c) => c.just_value / c.sqft));
    if (sqft > 0 && jv / sqft < JV_SUBJECT_MIN * jvPsf) return none("the appraiser value looks partial (new or changed since January 1)");
    const w = kept.map((c) => c.similarity * (c.sale_class === "distressed" ? DISTRESSED_WEIGHT : 1));
    const W = w.reduce((a, b) => a + b, 0);
    if (!W) return none("no weight");
    const r = kept.reduce((a, c, i) => a + w[i] * ratio(c), 0) / W;
    const fair = jv * r;
    const spread = Math.sqrt(kept.reduce((a, c, i) => a + w[i] * (jv * ratio(c) - fair) ** 2, 0) / W);
    return { fair_value: fair, range: [fair - spread, fair + spread], ratio: r, just_value: jv, used: kept.map((c) => c.parcel_id) };
  }

  function combineMethods(subject, comps, fair, spread) {
    const m = { comps: { fair_value: fair, range: fair == null ? null : [fair - spread, fair + spread] } };
    m.assessed = comps.length ? assessedValue(subject, comps) : { fair_value: null, range: null };
    const a = m.assessed;
    m.blend = fair != null && a.fair_value != null
      ? { fair_value: (fair + a.fair_value) / 2, range: [0, 1].map((i) => (m.comps.range[i] + a.range[i]) / 2) }
      : { fair_value: null, range: null, reason: "needs both comps and assessed values" };
    return m;
  }

  function finish(subject, chosen, model, tindex, asOf, reach, pool) {
    const yearNow = asOf.getUTCFullYear() + dayOfYear(asOf) / 366;
    const subjRow = { sqft: subject.sqft, year_built: subject.year_built, lot_acres: subject.lot_acres,
      baths: num(subject.baths, 2.0), stories: num(subject.stories, 1.0), quality: num(subject.quality, 4.0),
      pool: Boolean(subject.pool) };
    const subjX = design([subjRow], yearNow)[0];
    const compX = design(chosen.filter((c) => !c.forced));
    const compXForced = design(chosen.filter((c) => c.forced));
    let ki = 0, kf = 0;
    const comps = chosen.map((c) => {
      const x = c.forced ? compXForced[kf++] : compX[ki++];
      const adj = adjust(c, subjX, x, model, tindex);
      let weight = c.similarity / (1 + adj.gross_pct / 100);
      if (c.sale_class === "distressed") weight *= DISTRESSED_WEIGHT;
      const flags = [];
      if (Math.abs(adj.net_pct) > NET_LIMIT) flags.push("net adjustment over 15%");
      if (adj.gross_pct > GROSS_LIMIT) flags.push("gross adjustment over 25%");
      if (c.sale_class === "distressed") flags.push("distressed sale");
      if (c.forced) flags.push("added by you");
      return { ...c, ...adj, weight, flags };
    });
    const W = comps.reduce((a, c) => a + c.weight, 0);
    let fair = null, spread = null;
    if (comps.length && W > 0) {
      fair = comps.reduce((a, c) => a + c.weight * c.adjusted_price, 0) / W;
      spread = Math.sqrt(comps.reduce((a, c) => a + c.weight * (c.adjusted_price - fair) ** 2, 0) / W);
    }
    for (const c of comps) c.just_value = isNum(c.just_value) && c.just_value > 0 ? c.just_value : null;
    return { subject, as_of: ymd(asOf), search: reach, fair_value: fair,
      range: fair == null ? null : [fair - spread, fair + spread],
      methods: combineMethods(subject, comps, fair, spread), comps, pool_size: pool.length };
  }

  /** Why wasn't this sale a comp? Returns {verdict, reasons[], sale, whatIf}. */
  function explain(candidateKey, subject, sales, model, tindex, result, opts = {}) {
    const mine = sales.filter((s) => s.address && normalizeAddress(s.address) === candidateKey)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!mine.length) {
      return { verdict: "No recorded sale of this address in the last 24 months, so there's no price to compare.", reasons: [] };
    }
    const sale = mine[0];
    if (result.comps.some((c) => c.parcel_id === sale.parcel_id)) {
      return { verdict: "It's already one of the comps.", reasons: [], sale };
    }
    const asOf = parseDate(result.as_of);
    const reasons = [];
    if (sale.parcel_id === subject.parcel_id) reasons.push("It's the house being valued.");
    if (sale.sale_class === "non_market") reasons.push(`The sale isn't a market sale: ${sale.reason}.`);
    if (sale.sale_class === "distressed" && opts.includeDistressed === false) reasons.push("Distressed sales are switched off.");
    if (sale.property_type !== subject.property_type) reasons.push(`Different property type (${sale.property_type.replace("_", " ")} vs ${subject.property_type.replace("_", " ")}).`);
    const located = result.search.located && isNum(sale.lat) && isNum(subject.lat);
    const [withD] = withDistance([sale], subject, located);
    const cutoff = addMonths(asOf, -result.search.months);
    const areaOk = located
      ? withD.distance_mi <= parseFloat(result.search.area.replace(/[^\d.]/g, ""))
      : searchSteps(subject, false).find((s) => s.label === result.search.area).test(sale);
    if (!areaOk) reasons.push(located ? `It's ${withD.distance_mi.toFixed(2)} mi away; the search found enough comps ${result.search.area}.`
      : `It's outside the search area (${result.search.area}).`);
    if (!(parseDate(sale.date) > cutoff)) reasons.push(`It sold ${sale.date}, before the ${result.search.months}-month window.`);
    if (!inSize(sale, subject)) reasons.push(`Size differs by ${Math.round((sale.sqft / subject.sqft - 1) * 100)}% (limit ±35%).`);
    const newer = sales.find((s) => s.parcel_id === sale.parcel_id && s.date > sale.date &&
      ["market", "distressed"].includes(s.sale_class));
    if (newer) reasons.push(`A newer sale of the same house (${newer.date}) is used instead.`);

    const sim = similarity(withD, subject, asOf);
    if (!reasons.length) {
      const cutoffSim = Math.min(...result.comps.filter((c) => !c.forced).map((c) => c.similarity));
      if (sim.score < cutoffSim) {
        const p = sim.parts, big = [];
        if (p.size > 0.5) big.push(`size ${Math.round((sale.sqft / subject.sqft - 1) * 100)}%`);
        if (p.age > 0.5) big.push(`built ${sale.year_built} vs ${subject.year_built}`);
        if (p.dist > 0.5) big.push(`${withD.distance_mi.toFixed(2)} mi away`);
        if (p.months > 0.5) big.push(`sold ${sale.date}`);
        if (p.baths >= 1) big.push(`${sale.baths} vs ${subject.baths} baths`);
        if (p.pool) big.push(sale.pool ? "has a pool" : "no pool");
        if (p.lot > 0.5) big.push(`lot ${sale.lot_acres} vs ${subject.lot_acres} ac`);
        reasons.push(`Less similar than the ${result.comps.length} chosen comps (score ${sim.score.toFixed(2)} vs cutoff ${cutoffSim.toFixed(2)})` +
          (big.length ? `: ${big.join(", ")}.` : "."));
      }
    }
    // What if it were included?
    const forced = (opts.forced || []).concat([sale]);
    const whatIf = valueSubject(subject, sales, model, tindex, { ...opts, asOf: result.as_of, forced });
    const added = whatIf.comps.find((c) => c.parcel_id === sale.parcel_id);
    if (added && added.gross_pct > GROSS_LIMIT) reasons.push(`It would need ${added.gross_pct.toFixed(0)}% gross adjustments (limit 25%).`);
    return {
      verdict: reasons.length ? "Not used as a comp:" : "It qualifies but ranked just outside the top comps.",
      reasons, sale, adjusted: added, whatIf,
    };
  }

  const api = { MIN_COMPS, MAX_COMPS, FEATURES, SUFFIX, METHODS, normalizeAddress, parseAddress, candidateZips, fromTable, design,
    timeFactor, valueSubject, explain, haversine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Comps = api;
})(typeof window !== "undefined" ? window : globalThis);
