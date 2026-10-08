"use strict";

const COUNTY = "pasco";
const BASE = `data/counties/${COUNTY}/`;
const $ = (s) => document.querySelector(s);
const cache = new Map();
const state = { ctx: null, opts: { includeDistressed: true, excluded: [], forced: [] }, showMath: false, explain: null };

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
  return { meta, model, tindex, streets, neighbors };
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

  const vsList = list && r.fair_value ? (list / r.fair_value - 1) * 100 : null;
  const searchText = `${r.comps.filter((c) => !c.forced).length} comps ${esc(r.search.area)}, sold in the last ${r.search.months} months` +
    (r.search.located ? "" : " (no map location, matched by area)") + (r.search.thin ? " — few sales nearby, so the search had to reach far" : "");

  box.innerHTML = `
    <div class="detail">
      <div class="detail-head">
        <div><h2>${esc(s.address)}</h2><span class="place">${esc(s.city)} ${esc(s.zip)} · parcel ${esc(s.parcel_id)} · ${esc(s.nbhd_name || s.nbhd)}</span></div>
      </div>
      <div class="tiles">
        <div class="tile hero"><div class="label">Fair value</div><div class="value">${money(r.fair_value)}</div>
          <div class="note">range ${r.range ? money(r.range[0]) + " – " + money(r.range[1]) : "—"}</div></div>
        ${list ? `<div class="tile"><div class="label">List price</div><div class="value ${vsList > 0 ? "up-seller" : "up-buyer"}">${money(list)}</div>
          <div class="note">${pct(vsList)} vs fair value${r.range && list > r.range[1] ? " · above the range" : r.range && list < r.range[0] ? " · below the range" : ""}</div></div>` : ""}
        <div class="tile"><div class="label">The house</div><div class="value small">${Math.round(s.sqft).toLocaleString()} sq ft</div>
          <div class="note">${esc(type(s.property_type))}, built ${s.year_built}, ${s.baths ?? "—"} baths, ${s.stories >= 2 ? "two-story" : "one-story"}, lot ${s.lot_acres ?? "—"} ac, ${s.pool ? "pool" : "no pool"}</div></div>
        <div class="tile"><div class="label">Appraiser's just value</div><div class="value small">${money(s.just_value)}</div>
          <div class="note">for tax purposes; usually below market</div></div>
      </div>
      <p class="explain">${searchText}. Each sale is brought to today's prices with the ZIP's home value index, then adjusted for every difference using values fitted on Pasco sales. Closer matches and smaller adjustments count more.</p>

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

$("#lookup").onsubmit = (e) => { e.preventDefault(); run($("#addr").value); };
$("#list").addEventListener("input", () => { if (state.ctx) render(); });
const fromHash = decodeURIComponent((location.hash.match(/a=([^&]+)/) || [])[1] || "");
if (fromHash) { $("#addr").value = fromHash; run(fromHash); }
