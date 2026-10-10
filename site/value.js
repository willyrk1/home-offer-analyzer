"use strict";

const COUNTY = "pasco";
const BASE = `data/counties/${COUNTY}/`;
const $ = (s) => document.querySelector(s);
const cache = new Map();
const state = { ctx: null, opts: { includeDistressed: true, excluded: [], forced: [] }, showMath: false, explain: null, method: null, level: "80" };
const METHOD_NAMES = { comps: "Adjusted comps", assessed: "Appraiser ratio", blend: "Blend of both" };
const METHOD_DESC = {
  comps: "nearby sales, each adjusted for every difference from this house",
  assessed: "this house's appraiser value × what the comps sold for compared with theirs",
  blend: "the average of the two",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US");
const pct = (v, d = 1) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const type = (t) => String(t || "").replace("_", " ");

async function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(BASE + path).then((r) => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }));
  }
  return cache.get(path);
}

async function loadCommon() {
  const [meta, model, tindex, streets, neighbors] = await Promise.all(
    ["meta.json", "model.json", "tindex.json", "streets.json", "neighbors.json"].map(getJSON));
  const backtest = await getJSON("backtest.json").catch(() => null);   // optional
  return { meta, model, tindex, streets, neighbors, backtest };
}

async function findSubject(text, common) {
  const parsed = Comps.parseAddress(text);
  const zips = Comps.candidateZips(parsed, common.streets).filter((z) => common.meta.zips.includes(z));
  for (const z of zips) {
    const parcels = Comps.fromTable(await getJSON(`parcels/${z}.json`));
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
  return tables.filter(Boolean).flatMap(Comps.fromTable);
}

// ---------- run ----------
async function run(addressText) {
  $("#status").textContent = "Loading county data…";
  let common;
  try { common = await loadCommon(); }
  catch (e) { $("#status").textContent = "County data isn't published yet. The weekly build creates it."; return; }
  $("#model-note").textContent = modelNote(common);

  const found = await findSubject(addressText, common);
  if (!found.subject) {
    $("#result").hidden = true;
    $("#status").innerHTML = found.noStreet
      ? `Couldn't find that street in Pasco County records. Check the spelling, or include the ZIP.`
      : `No Pasco parcel matches that address.` + (found.similar.length ? ` Similar: ${found.similar.map(esc).join("; ")}.` : "");
    return;
  }
  const sales = await loadSales(found.subject.zip, common);
  state.ctx = { ...common, subject: found.subject, sales };
  state.opts = { includeDistressed: true, excluded: [], forced: [] };
  state.explain = null;
  $("#status").textContent = "";
  history.replaceState(null, "", `#a=${encodeURIComponent(addressText)}`);
  remember(found.subject);
  render();
}

function compute() {
  const { subject, sales, model, tindex, meta } = state.ctx;
  return Comps.valueSubject(subject, sales, model, tindex, { ...state.opts, asOf: meta.latest_sale });
}

function modelNote(c) {
  const m = c.model;
  return `County model: ${m.n_sales.toLocaleString()} market sales (${m.window[0]} to ${m.window[1]}), ` +
    `explains ${(m.r2 * 100).toFixed(0)}% of price variation; typical single-house miss before comps ${m.median_abs_pct_error.toFixed(0)}%. ` +
    `Sales recorded through ${c.meta.latest_sale}.`;
}

// ---------- render ----------
function render() {
  const r = compute();
  const s = r.subject;
  const list = parseFloat(($("#list").value || "").replace(/[^\d.]/g, "")) || null;
  const box = $("#result");
  box.hidden = false;

  const method = chosenMethod(r);
  const m = r.methods[method];
  const fair = m.fair_value;
  const cal = calibration(method);
  const range = (cal && Comps.calibratedRange(fair, m.range && m.range[0], m.range && m.range[1], s.zip, cal, state.level)) || m.range;
  const vsList = list && fair ? (list / fair - 1) * 100 : null;
  state.ctx.lastAssessedUsed = r.methods.assessed.used || null;
  const searchText = `${r.comps.filter((c) => !c.forced).length} comps ${esc(r.search.area)}, sold in the last ${r.search.months} months` +
    (r.search.located ? "" : " (no map location, matched by area)") + (r.search.thin ? " — few sales nearby, so the search had to reach far" : "");

  box.innerHTML = `
    <div class="detail">
      <div class="detail-head">
        <div><h2>${esc(s.address)}</h2><span class="place">${esc(s.city)} ${esc(s.zip)} · parcel ${esc(s.parcel_id)} · ${esc(s.nbhd_name || s.nbhd)}</span></div>
      </div>
      <div class="tiles">
        <div class="tile hero"><div class="label">Fair value · ${esc(METHOD_NAMES[method].toLowerCase())}</div><div class="value">${money(fair)}</div>
          <div class="note">${cal ? `${state.level}% range` : "range"} ${range ? money(range[0]) + " – " + money(range[1]) : "—"}${rangeNote(cal)}</div>
          ${cal ? `<div class="levels" role="group" aria-label="Range width">${Object.keys(cal.levels).map((lv) =>
            `<button type="button" class="link${lv === state.level ? " on" : ""}" data-level="${lv}" aria-pressed="${lv === state.level}">${lv}%</button>`).join("")}</div>` : ""}</div>
        ${list ? `<div class="tile"><div class="label">List price</div><div class="value ${vsList > 0 ? "up-seller" : "up-buyer"}">${money(list)}</div>
          <div class="note">${pct(vsList)} vs fair value${range && list > range[1] ? " · above the range" : range && list < range[0] ? " · below the range" : ""}</div></div>` : ""}
        <div class="tile"><div class="label">The house</div><div class="value small">${Math.round(s.sqft).toLocaleString()} sq ft</div>
          <div class="note">${esc(type(s.property_type))}, built ${s.year_built}, ${s.baths ?? "—"} baths, ${s.stories >= 2 ? "two-story" : "one-story"}, lot ${s.lot_acres ?? "—"} ac, ${s.pool ? "pool" : "no pool"}</div></div>
        <div class="tile"><div class="label">Appraiser's just value</div><div class="value small">${money(s.just_value)}</div>
          <div class="note">for tax purposes; usually below market</div></div>
      </div>
      ${methodPicker(r, method)}
      <p class="explain">${searchText}. Each sale is brought to today's prices with the ZIP's home value index, then adjusted for every difference using values fitted on Pasco sales. Closer matches and smaller adjustments count more.${assessedText(r, method)}</p>

      ${accuracyHtml(r, method)}

      <div class="controls">
        <label><input type="checkbox" id="opt-distressed" ${state.opts.includeDistressed ? "checked" : ""}> Include distressed sales (bank-owned, short sales) at half weight</label>
        <label><input type="checkbox" id="opt-math" ${state.showMath ? "checked" : ""}> Show the math for every comp</label>
      </div>

      <h3>Comps</h3>
      <div class="table-scroll">
        <table class="comps">
          <thead><tr><th>Address</th><th>Sold</th><th class="num">Price</th><th class="num">Distance</th><th class="num">Sq ft</th>
            <th class="num">Built</th><th class="num">Baths</th><th>Pool</th><th class="num">Adjusted</th><th class="num">Weight</th><th></th></tr></thead>
          <tbody>${r.comps.map((c, i) => compRow(c, i)).join("")}</tbody>
        </table>
      </div>
      ${state.opts.excluded.length ? `<p class="explain">Removed by you: ${state.opts.excluded.map((id) =>
        `<button class="link" data-restore="${esc(id)}">${esc(addressOf(id))} ↺</button>`).join(" ")}</p>` : ""}

      <h3>Why wasn't a sale used?</h3>
      <form id="why" class="picker">
        <input id="why-addr" class="wide" placeholder="Address of a sale you'd expect to see">
        <button type="submit">Check</button>
      </form>
      <div id="why-out">${state.explain ? explainHtml(state.explain, r) : ""}</div>
    </div>`;

  box.querySelectorAll("[data-level]").forEach((b) => b.onclick = () => { state.level = b.dataset.level; render(); });
  box.querySelectorAll("input[name=method]").forEach((el) => el.onchange = () => { state.method = el.value; render(); });
  $("#opt-distressed").onchange = (e) => { state.opts.includeDistressed = e.target.checked; render(); };
  $("#opt-math").onchange = (e) => { state.showMath = e.target.checked; render(); };
  box.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = () => {
    const row = box.querySelector(`#math-${b.dataset.toggle}`); row.hidden = !row.hidden;
    b.textContent = row.hidden ? "math" : "hide";
  });
  box.querySelectorAll("[data-remove]").forEach((b) => b.onclick = () => {
    const id = b.dataset.remove;
    state.opts.forced = state.opts.forced.filter((f) => f.parcel_id !== id);
    if (!b.dataset.forced) state.opts.excluded.push(id);
    render();
  });
  box.querySelectorAll("[data-restore]").forEach((b) => b.onclick = () => {
    state.opts.excluded = state.opts.excluded.filter((x) => x !== b.dataset.restore); render();
  });
  $("#why").onsubmit = (e) => { e.preventDefault(); runExplain($("#why-addr").value, r); };
  const add = box.querySelector("#force-add");
  if (add) add.onclick = () => {
    state.opts.forced.push(state.explain.sale);
    state.opts.excluded = state.opts.excluded.filter((x) => x !== state.explain.sale.parcel_id);
    state.explain = null; render();
  };
}

// ---------- valuation method (comps, assessed, blend: see pipeline/comps.py) ----------
/** Backtest results for a method: {view: {overall, by}, from, to} or null. */
function methodStats(method) {
  const bt = state.ctx.backtest;
  if (!bt) return null;
  const bm = bt.methods && bt.methods.by_method && bt.methods.by_method[method];
  if (bm && bm.overall.valued) return { view: bm, from: bt.methods.sales_from, to: bt.sales_to };
  if (method === "comps" && bt.overall.valued) return { view: bt, from: bt.sales_from, to: bt.sales_to };
  return null;
}
const bestMethod = () => (state.ctx.backtest && state.ctx.backtest.methods && state.ctx.backtest.methods.best) || "comps";

/** The method you picked, else the backtest's most accurate, else comps (when a method can't value this home). */
function chosenMethod(r) {
  for (const m of [state.method, bestMethod(), "comps"]) if (m && r.methods[m] && r.methods[m].fair_value != null) return m;
  return "comps";
}

function methodPicker(r, method) {
  const best = bestMethod();
  const opts = Comps.METHODS.map((k) => {
    const v = r.methods[k], st = methodStats(k), ok = v.fair_value != null;
    const acc = st ? `typical miss ${st.view.overall.median_abs_error_pct.toFixed(1)}% in the backtest` : "not backtested yet";
    return `<label class="method ${ok ? "" : "off"}"><input type="radio" name="method" value="${k}" ${k === method ? "checked" : ""} ${ok ? "" : "disabled"}>
      <span class="m-name">${esc(METHOD_NAMES[k])}${k === best ? ' <span class="tag-sm">most accurate</span>' : ""}</span>
      <span class="m-value">${ok ? money(v.fair_value) : "n/a"}</span>
      <span class="m-note">${esc(ok ? METHOD_DESC[k] : v.reason || "not available for this home")} · ${esc(acc)}</span></label>`;
  }).join("");
  return `<fieldset class="methods"><legend>Method</legend>${opts}</fieldset>`;
}

function assessedText(r, method) {
  const a = r.methods.assessed;
  if (method === "comps" || a.fair_value == null) return "";
  return ` <strong>Appraiser ratio:</strong> after the time adjustment, the comps sold for ${a.ratio.toFixed(3)}× their appraiser
    just values on average (weighted by similarity), so ${money(a.just_value)} × ${a.ratio.toFixed(3)} = ${money(a.fair_value)}.
    The appraiser's value already reflects size, age, lot and location, so no feature adjustments are applied.`;
}

// ---------- how accurate is this? (backtest.json from pipeline/backtest.py) ----------
function calibration(method) {
  const bt = state.ctx.backtest;
  const cal = bt && bt.methods && bt.methods.ranges && bt.methods.ranges[method];
  if (cal && !cal.levels[state.level]) state.level = Object.keys(cal.levels).includes("80") ? "80" : Object.keys(cal.levels)[0];
  return cal || null;
}

function rangeNote(cal) {
  if (!cal) return "";
  const c = cal.levels[state.level];
  return `<br>in past sales, ranges like this held the price ${Math.round(c.check_coverage_pct)}% of the time (wider where we miss more)`;
}

function accuracyHtml(r, method) {
  const stats = methodStats(method);
  if (!stats) return "";
  const bt = { ...state.ctx.backtest, ...stats.view, sales_from: stats.from };
  const s = state.ctx.subject;
  const fv = r.methods[method].fair_value;
  const band = fv == null ? null : bt.price_bands.find(([lo, hi]) => fv >= lo && (hi == null || fv < hi));
  const rows = [["All Pasco sales", bt.overall],
    [`ZIP ${s.zip}`, bt.by.zip[s.zip]],
    [band ? `${band[2]} homes` : null, band && bt.by.price_band[band[2]]],
    [{ single_family: "Single-family homes", townhome: "Townhomes", condo: "Condos" }[s.property_type] || type(s.property_type),
      bt.by.property_type[s.property_type]]]
    .filter(([label, g]) => label && g && g.valued);
  const lean = (b) => Math.abs(b) < 1 ? "none" : `${b > 0 ? "high" : "low"} ${Math.abs(b).toFixed(0)}%`;
  const zipRow = bt.by.zip[s.zip];
  const warn = zipRow && zipRow.median_abs_error_pct > 12
    ? `<p class="explain warn">Misses are larger than usual in ZIP ${esc(s.zip)}. Older homes there vary a lot in condition and upgrades, which county records don't show — lean on the comps you can actually see.</p>` : "";
  const fmtDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return `
    <details class="accuracy">
      <summary><h3>How accurate is this?</h3> <span>${esc(METHOD_NAMES[method])}:</span> <span>typical miss ${bt.overall.median_abs_error_pct.toFixed(0)}% county-wide${zipRow && zipRow.valued ? `, ${zipRow.median_abs_error_pct.toFixed(0)}% in ${esc(s.zip)}` : ""}</span></summary>
      <p class="explain">We valued ${bt.overall.valued.toLocaleString()} Pasco market sales (${fmtDate(bt.sales_from)} – ${fmtDate(bt.sales_to)}) the same way,
        each as of the day before it sold and using only sales and prices known then, and compared with what they sold for.</p>
      <div class="table-scroll"><table class="acc">
        <thead><tr><th></th><th class="num">Sales</th><th class="num">Typical miss</th><th class="num">Within 10%</th><th class="num">Lean</th></tr></thead>
        <tbody>${rows.map(([label, g]) => `<tr><td>${esc(label)}</td><td class="num">${g.valued.toLocaleString()}</td>
          <td class="num">${g.median_abs_error_pct.toFixed(1)}%</td><td class="num">${g.within_10_pct.toFixed(0)}%</td>
          <td class="num">${lean(g.bias_pct)}</td></tr>`).join("")}</tbody>
      </table></div>
      ${warn}
      ${rangeCheck(method)}
      <p class="explain">Typical miss = median gap between our value and the sale price; half of sales missed by less. Lean = whether we tend to come in high or low.
        ${stats.from !== state.ctx.backtest.sales_from ? `Methods are compared on sales since ${fmtDate(stats.from)}, after the appraiser's January 1 values were set, so the appraiser's figure never saw the sale it's tested on.` : ""}
        ${bt.overall.regression_only ? `The county model alone, without comps, missed by ${bt.overall.regression_only.median_abs_error_pct.toFixed(1)}%.` : ""}
        Source: Pasco County Property Appraiser recorded sales, backtest run on sales through ${esc(bt.sales_to)}.</p>
    </details>`;
}

function rangeCheck(method) {
  const cal = calibration(method);
  if (!cal) return "";
  return `<p class="explain">Ranges are sized from how far off we were in past sales in this ZIP and how much the comps disagree.
    Fitted on alternate months and checked on the others, they held the sale price ${Object.entries(cal.levels)
      .map(([lv, c]) => `${Math.round(c.check_coverage_pct)}% of the time (${lv}% range)`).join(", ")}.</p>`;
}

function addressOf(parcelId) {
  const s = state.ctx.sales.find((x) => x.parcel_id === parcelId);
  return s ? s.address : parcelId;
}

function compRow(c, i) {
  const flags = c.flags.length ? `<div class="flags">${c.flags.map(esc).join(" · ")}</div>` : "";
  const math = `
    <tr id="math-${i}" class="math" ${state.showMath ? "" : "hidden"}><td colspan="11">
      <table class="mathtable">
        <tr><td>Sale price (${esc(c.date)}, ${esc(c.sale_class)})</td><td></td><td class="num">${money(c.price)}</td></tr>
        <tr><td>Time: ZIP ${esc(c.zip)} index ${esc(c.time_note)}</td><td class="num">×${c.time_factor.toFixed(3)}</td><td class="num">${money(c.time_adjusted)}</td></tr>
        ${c.just_value ? `<tr><td>Appraiser ratio: ${money(c.time_adjusted)} ÷ appraiser value ${money(c.just_value)}${
          state.ctx.lastAssessedUsed && !state.ctx.lastAssessedUsed.includes(c.parcel_id) ? " (not used: far from the other comps' ratios)" : ""}</td>
          <td class="num">${(c.time_adjusted / c.just_value).toFixed(3)}</td><td></td></tr>` : ""}
        ${c.adjustments.map((a) => `<tr><td>${esc(a.label)}: ${describeDiff(a, c)}</td>
          <td class="num">${pct(a.pct)}</td><td class="num">${a.dollars >= 0 ? "+" : "−"}${money(Math.abs(a.dollars))}</td></tr>`).join("")}
        <tr class="total"><td>Adjusted price (net ${pct(c.net_pct)}, gross ${c.gross_pct.toFixed(1)}%)</td><td></td><td class="num">${money(c.adjusted_price)}</td></tr>
        <tr><td colspan="3" class="explain">Weight ${c.weight.toFixed(2)} = similarity ${c.similarity.toFixed(2)} ÷ (1 + ${(c.gross_pct / 100).toFixed(3)} gross)${c.sale_class === "distressed" ? " × 0.5 distressed" : ""}</td></tr>
      </table></td></tr>`;
  return `<tr class="comp">
      <td class="addr" data-label="">${esc(c.address)}${c.subdivision === state.ctx.subject.subdivision ? ' <span class="tag-sm">same subdivision</span>' : ""}${flags}</td>
      <td data-label="Sold">${esc(c.date)}</td><td class="num" data-label="Price">${money(c.price)}</td>
      <td class="num" data-label="Distance">${c.distance_mi.toFixed(2)} mi</td><td class="num" data-label="Sq ft">${Math.round(c.sqft).toLocaleString()}</td>
      <td class="num" data-label="Built">${c.year_built ?? "—"}</td><td class="num" data-label="Baths">${c.baths ?? "—"}</td><td data-label="Pool">${c.pool ? "yes" : "no"}</td>
      <td class="num strong" data-label="Adjusted">${money(c.adjusted_price)}</td><td class="num" data-label="Weight">${c.weight.toFixed(2)}</td>
      <td class="actions"><button class="link" data-toggle="${i}">${state.showMath ? "hide" : "math"}</button>
        <button class="link" data-remove="${esc(c.parcel_id)}" ${c.forced ? 'data-forced="1"' : ""} title="Remove this comp" aria-label="Remove ${esc(c.address)}">✕</button></td>
    </tr>${math}`;
}

function describeDiff(a, c) {
  const s = state.ctx.subject;
  switch (a.feature) {
    case "ln_sqft": return `${Math.round(s.sqft)} vs ${Math.round(c.sqft)} sq ft`;
    case "age": return `built ${s.year_built} vs ${c.year_built}`;
    case "new": return a.difference > 0 ? "subject is new" : "comp is new";
    case "ln_lot": return `lot ${s.lot_acres} vs ${c.lot_acres} ac`;
    case "baths": return `${s.baths} vs ${c.baths} baths`;
    case "pool": return a.difference > 0 ? "subject has a pool" : "comp has a pool";
    case "two_story": return a.difference > 0 ? "subject is two-story" : "comp is two-story";
    case "quality": return `quality grade ${s.quality} vs ${c.quality}`;
    default: return "";
  }
}

function runExplain(text, r) {
  const { subject, sales, model, tindex } = state.ctx;
  const key = Comps.normalizeAddress(String(text).split(",")[0]);
  state.explain = Comps.explain(key, subject, sales, model, tindex, r, state.opts);
  $("#why-out").innerHTML = explainHtml(state.explain, r);
  const add = $("#force-add");
  if (add) add.onclick = () => {
    state.opts.forced.push(state.explain.sale);
    state.opts.excluded = state.opts.excluded.filter((x) => x !== state.explain.sale.parcel_id);
    state.explain = null; render();
  };
}

function explainHtml(x, r) {
  if (!x.sale) return `<p>${esc(x.verdict)}</p>`;
  const s = x.sale;
  let html = `<div class="why"><p><strong>${esc(s.address)}</strong> sold ${esc(s.date)} for ${money(s.price)} (${esc(s.sale_class.replace("_", "-"))}).</p>
    <p>${esc(x.verdict)}</p>${x.reasons.length ? `<ul>${x.reasons.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}`;
  if (x.whatIf && x.whatIf.fair_value != null && r.fair_value != null && x.sale.parcel_id !== state.ctx.subject.parcel_id) {
    const d = x.whatIf.fair_value - r.fair_value;
    html += `<p>If you include it${x.adjusted ? ` (adjusted price ${money(x.adjusted.adjusted_price)})` : ""}, fair value moves from ${money(r.fair_value)} to
      <strong>${money(x.whatIf.fair_value)}</strong> (${d >= 0 ? "+" : "−"}${money(Math.abs(d))}).
      ${Math.abs(d) < 2500 ? "That's too small to matter." : "That's a judgment call worth making knowingly."}</p>
      <button type="button" id="force-add">Add it anyway</button>`;
  }
  return html + "</div>";
}

// ---------- recently valued homes (this browser only) ----------
const RECENT_KEY = "hoa:recent:" + COUNTY, RECENT_MAX = 10;

function recents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function saveRecents(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* storage off */ }
}
function remember(s) {
  const item = { id: s.parcel_id, label: s.address, sub: `${s.city} ${s.zip}`,
    value: `${s.address}, ${s.city}, FL ${s.zip}`, list: $("#list").value.trim() };
  saveRecents([item, ...recents().filter((r) => r.id !== s.parcel_id)]);
}
function forget(id) { saveRecents(recents().filter((r) => r.id !== id)); }

// ---------- address autocomplete ----------
const ac = { idx: null, loading: null, items: [], active: -1, timer: null };
const addrInput = $("#addr"), addrList = $("#addr-list");

function loadAddresses() {
  if (!ac.loading) {
    ac.loading = getJSON("addresses.json").then((ix) => { ac.idx = Addr.prepare(ix); }).catch(() => { ac.idx = null; });
  }
  return ac.loading;
}

function suggestions(text) {
  const q = text.trim().toUpperCase();
  const words = q.split(/[\s,]+/).filter(Boolean);
  const mine = recents().filter((r) => !q || words.every((w) => r.value.toUpperCase().includes(w)))
    .map((r) => ({ ...r, kind: "recent" }));
  if (!q) return mine;
  const found = ac.idx ? Addr.search(text, ac.idx, 8) : [];
  const seen = new Set(mine.map((r) => r.value.toUpperCase()));
  return [...mine.slice(0, 3), ...found.filter((f) => !seen.has(f.value.toUpperCase()))].slice(0, 10);
}

function optionHtml(it, i) {
  const tag = it.kind === "recent" ? (it.list ? `listed ${money(parseFloat(it.list.replace(/[^\d.]/g, "")))}` : "recent")
    : it.kind === "street" ? "street" : it.near ? "nearest number" : "";
  const forget = it.kind === "recent" ? `<button type="button" class="forget" data-forget="${esc(it.id)}" aria-label="Forget ${esc(it.label)}" tabindex="-1">✕</button>` : "";
  return `<li role="option" id="ac-${i}" data-i="${i}" aria-selected="${i === ac.active}">
    <span class="main">${esc(it.label)}<small>${esc(it.sub)}</small></span><span class="tag">${esc(tag)}</span>${forget}</li>`;
}

function showList(items) {
  ac.items = items;
  ac.active = -1;
  if (!items.length) return closeList();
  const firstFound = items.findIndex((it) => it.kind !== "recent");
  addrList.innerHTML = items.map((it, i) =>
    (i === 0 && it.kind === "recent" ? `<li class="head" role="presentation">Recently valued</li>` : "") +
    (i === firstFound && firstFound > 0 ? `<li class="head" role="presentation">Addresses</li>` : "") +
    optionHtml(it, i)).join("");
  addrList.hidden = false;
  addrInput.setAttribute("aria-expanded", "true");
  addrInput.removeAttribute("aria-activedescendant");
}

function closeList() {
  addrList.hidden = true;
  ac.items = []; ac.active = -1;
  addrInput.setAttribute("aria-expanded", "false");
  addrInput.removeAttribute("aria-activedescendant");
}

function setActive(i) {
  ac.active = (i + ac.items.length) % ac.items.length;
  addrList.querySelectorAll("[role=option]").forEach((li) => li.setAttribute("aria-selected", String(+li.dataset.i === ac.active)));
  const li = $(`#ac-${ac.active}`);
  addrInput.setAttribute("aria-activedescendant", li.id);
  li.scrollIntoView({ block: "nearest" });
}

function choose(it) {
  addrInput.value = it.value;
  if (it.kind === "street") {              // picked a street: now list its houses
    addrInput.focus();
    return refresh();
  }
  closeList();
  if (it.kind === "recent" && it.list) $("#list").value = it.list;
  run(it.value);
}

async function refresh() {
  if (!ac.idx && addrInput.value.trim()) await loadAddresses();
  if (document.activeElement === addrInput) showList(suggestions(addrInput.value));
}

addrInput.addEventListener("focus", () => {
  loadAddresses();
  addrInput.select();                      // typing replaces the prefilled address
  const mine = suggestions("");
  if (mine.length) showList(mine);
});
addrInput.addEventListener("input", () => { clearTimeout(ac.timer); ac.timer = setTimeout(refresh, 60); });
addrInput.addEventListener("blur", () => setTimeout(closeList, 150));
addrInput.addEventListener("keydown", (e) => {
  if (addrList.hidden) {
    if (e.key === "ArrowDown") { refresh(); e.preventDefault(); }
    return;
  }
  if (e.key === "ArrowDown") { setActive(ac.active + 1); e.preventDefault(); }
  else if (e.key === "ArrowUp") { setActive(ac.active - 1); e.preventDefault(); }
  else if (e.key === "Escape") { closeList(); e.preventDefault(); }
  else if (e.key === "Enter" && ac.active >= 0) { choose(ac.items[ac.active]); e.preventDefault(); }
});
addrList.addEventListener("mousedown", (e) => e.preventDefault());   // keep focus in the input
addrList.addEventListener("click", (e) => {
  const f = e.target.closest("[data-forget]");
  if (f) { forget(f.dataset.forget); return showList(suggestions(addrInput.value === addrInput.defaultValue ? "" : addrInput.value)); }
  const li = e.target.closest("[role=option]");
  if (li) choose(ac.items[+li.dataset.i]);
});

$("#lookup").onsubmit = (e) => { e.preventDefault(); closeList(); run(addrInput.value); };
$("#list").addEventListener("input", () => {
  if (!state.ctx) return;
  render();
  const s = state.ctx.subject;
  saveRecents(recents().map((r) => (r.id === s.parcel_id ? { ...r, list: $("#list").value.trim() } : r)));
});
const fromHash = decodeURIComponent((location.hash.match(/a=([^&]+)/) || [])[1] || "");
const last = recents()[0];
if (fromHash) { addrInput.value = fromHash; run(fromHash); }
else if (last) { addrInput.value = last.value; addrInput.defaultValue = last.value; if (last.list) $("#list").value = last.list; }
