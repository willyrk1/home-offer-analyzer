"use strict";

const { COUNTY, getJSON, loadCommon, findSubject, loadSales } = County;     // site/county.js, shared with math.js
const $ = (s) => document.querySelector(s);
const state = { ctx: null, opts: { includeDistressed: true, excluded: [], forced: [] }, showBreakdown: false, explain: null, method: null, level: "80" };
// Time adjustment: the ZIP's Zillow index alone, or plus the neighborhood's own trend vs that index
// (pipeline/comps.neighborhood_trends). Default = the backtest winner: the ZIP index alone (the
// neighborhood trend didn't lower the miss at any strength; CLAUDE.md, "Neighborhood trend").
const TIME_DEFAULT = "zip";
state.time = TIME_DEFAULT;
const METHOD_NAMES = { comps: "Adjusted comps", assessed: "Just-value ratio", blend: "Blend of both" };
const METHOD_DESC = {
  comps: "nearby sales, each adjusted for every difference from this house",
  assessed: "this house's just value × what the comps sold for compared with theirs",
  blend: "the average of the two",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US");
const pct = (v, d = 1) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const type = (t) => String(t || "").replace("_", " ");

// ---------- run ----------
/** settings: from the link (County.decodeSettings) when the page opens; otherwise a fresh start for this home. */
async function run(addressText, settings = null) {
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
  const [sales, market] = await Promise.all([loadSales(found.subject.zip, common),
    getJSON(`../../zips/${found.subject.zip}.json`).catch(() => null)]);
  state.ctx = { ...common, subject: found.subject, sales, market };
  state.opts = { includeDistressed: true, excluded: [], forced: [] };
  if (settings) {
    Object.assign(state, { method: settings.method, level: settings.level, time: settings.time });
    state.opts = { includeDistressed: settings.includeDistressed, excluded: settings.excluded.slice(),
      forced: County.findForced(settings.forced, allSales()) };
  }
  state.explain = null;
  state.builder = false; state.builderOwned = false;                  // per home: off by default
  state.trendGroup = null;                                            // per home: pick the best-supported group
  Object.assign(offerIn, { dom: "", lot: "", cpsf: "", carry: "", months: "" });
  $("#status").textContent = "";
  state.address = addressText;
  remember(found.subject);
  render();
}

function compute() {
  const { subject, model, tindex } = state.ctx;
  return Comps.valueSubject(subject, allSales(), model, tindex, engineOpts());
}

function engineOpts() {
  const t = state.ctx.nbhdTrend;
  return { ...state.opts, asOf: asOfDate(), local: state.time === "nbhd" && t ? t.nbhds : null };
}

// ---------- your Redfin "recently sold" file (site/upload.js): this browser only, never published ----------
const UPLOAD_KEY = County.UPLOAD_KEY;
let uploaded = County.readUploaded();
const uploadedSales = () => (uploaded && uploaded.added) || [];
const allSales = () => state.ctx.sales.concat(uploadedSales());
/** "As of" = the newest market sale, county-recorded or from your file (CLAUDE.md invariant 2). */
function asOfDate() { return County.asOf(state.ctx && state.ctx.meta, uploadedSales()); }

async function addRedfinFile(file) {
  const common = await loadCommon();
  const parsed = Upload.parseRedfin(await file.text());
  if (parsed.error) return { error: parsed.error };
  const zips = [...new Set(parsed.sales.map((s) => s.zip).filter((z) => common.meta.zips.includes(z)))];
  const [parcels, recorded] = await Promise.all([
    Promise.all(zips.map((z) => getJSON(`parcels/${z}.json`).then(Comps.fromTable))),
    Promise.all(zips.map((z) => getJSON(`sales/${z}.json`).then(Comps.fromTable).catch(() => []))),
  ]);
  const index = Upload.indexParcels(Object.fromEntries(zips.map((z, i) => [z, parcels[i]])));
  const out = Upload.toComps(parsed, index, recorded.flat());
  // Merge with what's already stored: a newer file replaces rows for the same sale.
  const keep = uploadedSales().filter((s) => !out.added.some((a) => a.parcel_id === s.parcel_id && a.date === s.date));
  uploaded = { added: keep.concat(out.added), skipped: out.skipped, file: file.name,
    at: new Date().toISOString().slice(0, 10), last_added: out.added.length };
  try { localStorage.setItem(UPLOAD_KEY, JSON.stringify(uploaded)); }
  catch { return { ...out, warning: "Your browser didn't let us save the file, so it will be gone after a reload." }; }
  return out;
}

function forgetRedfin() {
  uploaded = null;
  try { localStorage.removeItem(UPLOAD_KEY); } catch { /* storage off */ }
}

function uploadHtml() {
  const n = uploadedSales().length;
  const last = n ? uploadedSales().reduce((a, s) => (s.date > a ? s.date : a), "") : null;
  const sk = (uploaded && uploaded.skipped) || [];
  return `
    <h3>Recent sales not in county records yet</h3>
    <p class="explain">County records run through ${esc(state.ctx.meta.latest_sale)} and lag closings by a few weeks. To add newer sales, on Redfin
      search the area, filter to <em>Sold</em> (last 1–3 months), then <em>Download All</em> under the results, and add the file here.
      It stays in this browser: it isn't uploaded anywhere or published (it's MLS data, which isn't ours to share).</p>
    <div class="picker small">
      <label for="redfin-file">Redfin CSV</label><input type="file" id="redfin-file" accept=".csv,text/csv">
      ${n ? `<button type="button" class="link" id="redfin-forget">Remove the ${n} added sales</button>` : ""}
    </div>
    <div id="redfin-out" role="status">${n ? `<p class="explain">Using ${n} sales from ${esc(uploaded.file)} (through ${esc(last)}),
      marked "from your Redfin file" in the comps. Values are as of ${esc(asOfDate())}.</p>` : ""}
      ${sk.length ? `<details><summary class="explain">${sk.length} rows from the last file weren't used</summary><ul class="explain">${sk.slice(0, 50).map((s) =>
        `<li>${esc(s.address || "line " + s.line)}: ${esc(s.reason)}</li>`).join("")}${sk.length > 50 ? `<li>…and ${sk.length - 50} more</li>` : ""}</ul></details>` : ""}</div>`;
}

function bindUpload() {
  const f = $("#redfin-file");
  if (!f) return;
  f.onchange = async () => {
    if (!f.files[0]) return;
    $("#redfin-out").innerHTML = `<p class="explain">Reading ${esc(f.files[0].name)}…</p>`;
    const out = await addRedfinFile(f.files[0]);
    if (out.error) { $("#redfin-out").innerHTML = `<p class="explain warn">${esc(out.error)}</p>`; return; }
    render();
    if (out.warning) $("#redfin-out").insertAdjacentHTML("afterbegin", `<p class="explain warn">${esc(out.warning)}</p>`);
  };
  const forget = $("#redfin-forget");
  if (forget) forget.onclick = () => { forgetRedfin(); render(); };
}

function modelNote(c) {
  const m = c.model;
  return `County model: ${m.n_sales.toLocaleString()} market sales (${m.window[0]} to ${m.window[1]}), ` +
    `explains ${(m.r2 * 100).toFixed(0)}% of price variation; typical single-house miss before comps ${m.median_abs_pct_error.toFixed(0)}%. ` +
    `Sales recorded through ${c.meta.latest_sale}` + (uploadedSales().length ? `, plus ${uploadedSales().length} from your Redfin file.` : ".");
}

// ---------- render ----------
/** This page's settings as a link: the same home, method, range and comps. focus = a comp to jump to on math.html. */
function link(focus = null) {
  return County.encodeSettings({ a: state.address, method: state.method, level: state.level, time: state.time,
    includeDistressed: state.opts.includeDistressed, excluded: state.opts.excluded, forced: state.opts.forced, focus });
}

function render() {
  const r = compute();
  history.replaceState(null, "", link());
  const s = r.subject;
  const list = parseFloat(($("#list").value || "").replace(/[^\d.]/g, "")) || null;
  const box = $("#result");
  box.hidden = false;

  $("#model-note").textContent = modelNote(state.ctx);
  const method = chosenMethod(r);
  const m = r.methods[method];
  const fair = m.fair_value;
  const cal = calibration(method);
  const range = (cal && Comps.calibratedRange(fair, m.range && m.range[0], m.range && m.range[1], s.zip, cal, state.level)) || m.range;
  const vsList = list && fair ? (list / fair - 1) * 100 : null;
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
        <div class="tile"><div class="label">Just value</div><div class="value small">${money(s.just_value)}</div>
          <div class="note">Pasco appraiser: the county's market estimate as of Jan 1, not the capped value on the tax bill; homes usually sell ~15% above it</div></div>
      </div>
      ${methodPicker(r, method)}
      <p class="explain">${searchText}. Each sale is brought to today's prices with ${state.time === "nbhd" && state.ctx.nbhdTrend ? "the ZIP's home value index and its neighborhood's trend" : "the ZIP's home value index"}, then adjusted for every difference using values fitted on Pasco sales. Closer matches and smaller adjustments count more.${assessedText(r, method)}</p>

      ${breakdownHtml(r, method, cal, range)}

      ${accuracyHtml(r, method)}

      ${offerHtml(r, method)}

      <section class="trend" id="trend"></section>

      <div class="controls">
        <label><input type="checkbox" id="opt-distressed" ${state.opts.includeDistressed ? "checked" : ""}> Include distressed sales (bank-owned, short sales) at half weight</label>
      </div>
      ${timeHtml(s)}

      <h3>Comps</h3>
      <div class="table-scroll">
        <table class="comps">
          <thead><tr><th>Address</th><th>Sold</th><th class="num">Price</th><th class="num">Distance</th><th class="num">Sq ft</th>
            <th class="num">Built</th><th class="num">Baths</th><th>Pool</th><th class="num">Adjusted</th><th class="num">Weight</th><th></th></tr></thead>
          <tbody>${r.comps.map(compRow).join("")}</tbody>
        </table>
      </div>
      ${state.opts.excluded.length ? `<p class="explain">Removed by you: ${state.opts.excluded.map((id) =>
        `<button class="link" data-restore="${esc(id)}">${esc(addressOf(id))} ↺</button>`).join(" ")}</p>` : ""}

      ${uploadHtml()}

      <h3>Why wasn't a sale used?</h3>
      <form id="why" class="picker">
        <input id="why-addr" class="wide" placeholder="Address of a sale you'd expect to see">
        <button type="submit">Check</button>
      </form>
      <div id="why-out">${state.explain ? explainHtml(state.explain, r) : ""}</div>
    </div>`;

  const bd = $("#breakdown");
  if (bd) bd.ontoggle = () => { state.showBreakdown = bd.open; };
  bindOffer(r, method);
  renderTrend();
  bindUpload();
  box.querySelectorAll("[data-level]").forEach((b) => b.onclick = () => { state.level = b.dataset.level; render(); });
  box.querySelectorAll("input[name=method]").forEach((el) => el.onchange = () => { state.method = el.value; render(); });
  $("#opt-distressed").onchange = (e) => { state.opts.includeDistressed = e.target.checked; render(); };
  box.querySelectorAll("input[name=time]").forEach((el) => el.onchange = () => { state.time = el.value; render(); });
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
const bestMethod = () => County.bestMethod(state.ctx.backtest);
const chosenMethod = (r) => County.pickMethod(r, state.method, state.ctx.backtest);

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
  return ` <strong>Just-value ratio:</strong> after the time adjustment, the comps sold for ${a.ratio.toFixed(3)}× their
    just values (the county's Jan 1 market estimates) on average (weighted by similarity), so ${money(a.just_value)} × ${a.ratio.toFixed(3)} = ${money(a.fair_value)}.
    The just value already reflects size, age, lot and location, so no feature adjustments are applied.`;
}

// ---------- how we got the fair value: every step from sales to the number in the hero tile ----------
const FEATURE_UNIT = {
  ln_sqft: (b) => `${b.toFixed(2)}% per 1% more sq ft`,
  age: (b) => `${pct(Math.expm1(b) * 100, 2)} per year older`,
  new: (b) => pct(Math.expm1(b) * 100),
  ln_lot: (b) => `${b.toFixed(3)}% per 1% more lot`,
  baths: (b) => `${pct(Math.expm1(b) * 100)} per bath`,
  pool: (b) => pct(Math.expm1(b) * 100),
  two_story: (b) => pct(Math.expm1(b) * 100),
  quality: (b) => `${pct(Math.expm1(b) * 100)} per grade step`,
};
const SIM_LABELS = { size: "size", age: "age", lot: "lot", baths: "baths", pool: "pool", dist: "distance", months: "how long ago" };
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);
const f3 = (v) => v.toFixed(3);

function breakdownHtml(r, method, cal, range) {
  const m = r.methods[method];
  if (m.fair_value == null || !r.comps.length) return "";
  const s = r.subject, comps = r.comps, model = state.ctx.model;
  const W = sumOf(comps.map((c) => c.weight));
  const comp = r.methods.comps.fair_value;
  const spread = (r.methods.comps.range[1] - r.methods.comps.range[0]) / 2;
  const step = (n, title, body) => `<h4>${n}. ${title}</h4>${body}`;
  let n = 0;

  const find = step(++n, "Find the comps", `<p class="explain">Start from the ${r.pool_size.toLocaleString()} recorded ${esc(type(s.property_type))} sales
    (${state.opts.includeDistressed ? "market and distressed" : "market only"}) in ${esc(s.zip)} and neighboring ZIPs, latest sale of each house, this house excluded.
    Widen the search until at least ${Comps.MIN_COMPS} sales qualify: it stopped at <b>${esc(r.search.area)}, sold in the last ${r.search.months} months</b>,
    size within ±${Math.round(Comps.SIZE_LIMIT * 100)}% of ${Math.round(s.sqft).toLocaleString()} sq ft. Keep the ${Comps.MAX_COMPS} most similar
    (similarity score, below)${comps.some((c) => c.forced) ? ", plus the ones you added" : ""}.</p>`);

  const coefs = Comps.FEATURES.filter((f) => model.features[f] && isFinite(model.features[f].coef))
    .map((f) => `${esc(model.features[f].label.replace(/ \(.*\)$/, ""))} ${FEATURE_UNIT[f](model.features[f].coef)}`).join("; ");
  const rows = comps.map((c) => {
    const share = c.weight / W;
    return `<tr><td>${esc(c.address)}</td><td class="num">${money(c.price)}</td><td class="num">×${f3(c.time_factor)}</td>
      <td class="num">${money(c.time_adjusted)}</td><td class="num">${pct(c.net_pct)}</td><td class="num strong">${money(c.adjusted_price)}</td>
      <td class="num">${c.weight.toFixed(3)}</td><td class="num">${(share * 100).toFixed(1)}%</td><td class="num">${money(share * c.adjusted_price)}</td></tr>`;
  }).join("");
  const sumWA = sumOf(comps.map((c) => c.weight * c.adjusted_price));
  const adjust = step(++n, "Bring each sale to today and adjust it to this house", `<p class="explain">Time: each price × the change in
    ${state.time === "nbhd" && state.ctx.nbhdTrend ? "the comp ZIP's Zillow home value index and its neighborhood's trend" : "the comp ZIP's Zillow home value index"}
    from the month it sold to the latest month. Features: for each difference, × e<sup>coef × difference</sup>, with coefficients fitted on
    ${model.n_sales.toLocaleString()} Pasco market sales: ${coefs}. <a href="math.html${esc(link())}">Every number, comp by comp</a>.</p>
    <div class="table-scroll"><table class="acc">
      <thead><tr><th>Comp</th><th class="num">Sold for</th><th class="num">Time</th><th class="num">Today</th><th class="num">Features</th>
        <th class="num">Adjusted</th><th class="num">Weight</th><th class="num">Share</th><th class="num">Counts for</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td></td><td></td><td></td><td></td><td></td><td class="num">${W.toFixed(3)}</td><td class="num">100%</td><td class="num strong">${money(comp)}</td></tr></tfoot>
    </table></div>`);

  const weights = step(++n, "Weight the comps", `<p class="explain">Weight = similarity ÷ (1 + gross adjustment)${comps.some((c) => c.sale_class === "distressed")
    ? ` × ${Comps.DISTRESSED_WEIGHT} for distressed sales` : ""}, so close matches that need little adjusting count most. Share = weight ÷ ${W.toFixed(3)} (the total).</p>
    ${similarityHtml(r)}`);

  const avg = step(++n, "Average them", `<p class="explain">Adjusted comps value = Σ(weight × adjusted price) ÷ Σ weight
    = ${money(sumWA)} ÷ ${W.toFixed(3)} = <b>${money(comp)}</b>. The comps disagree by ±${money(spread)}
    (weighted standard deviation of the adjusted prices), ${(spread / comp * 100).toFixed(1)}% of the value.</p>`);

  let methodSteps = "";
  const a = r.methods.assessed;
  if (method !== "comps" && a.fair_value != null) {
    const used = new Set(a.used);
    const aw = (c) => c.similarity * (c.sale_class === "distressed" ? Comps.DISTRESSED_WEIGHT : 1);
    const AW = sumOf(comps.filter((c) => used.has(c.parcel_id)).map(aw));
    const arows = comps.filter((c) => c.just_value).map((c) => {
      const on = used.has(c.parcel_id);
      return `<tr${on ? "" : ' class="thin"'}><td>${esc(c.address)}${on ? "" : " (not used: far from the others)"}</td><td class="num">${money(c.time_adjusted)}</td>
        <td class="num">${money(c.just_value)}</td><td class="num">${f3(c.time_adjusted / c.just_value)}</td>
        <td class="num">${on ? aw(c).toFixed(3) : "—"}</td><td class="num">${on ? (aw(c) / AW * 100).toFixed(1) + "%" : "—"}</td></tr>`;
    }).join("");
    methodSteps += step(++n, "Just-value ratio", `<p class="explain">For each comp, today's price ÷ its just value; ratios more than
      1.5× from the median are dropped. Weighted by similarity${comps.some((c) => c.sale_class === "distressed") ? ` (× ${Comps.DISTRESSED_WEIGHT} distressed)` : ""}
      — no gross-adjustment penalty, since nothing is adjusted.</p>
      <div class="table-scroll"><table class="acc">
        <thead><tr><th>Comp</th><th class="num">Today</th><th class="num">Just value</th><th class="num">Ratio</th><th class="num">Weight</th><th class="num">Share</th></tr></thead>
        <tbody>${arows}</tbody>
      </table></div>
      <p class="explain">Weighted ratio ${f3(a.ratio)} × this house's just value ${money(a.just_value)} = <b>${money(a.fair_value)}</b>
        (±${money((a.range[1] - a.range[0]) / 2)} spread across the comps).</p>`);
  }
  if (method === "blend") {
    methodSteps += step(++n, "Blend", `<p class="explain">(${money(comp)} adjusted comps + ${money(a.fair_value)} just-value ratio) ÷ 2
      = <b>${money(m.fair_value)}</b>. Spread: the average of the two, ±${money((m.range[1] - m.range[0]) / 2)}.</p>`);
  }

  let rangeStep = "";
  const rp = cal && Comps.calibratedRangeParts(m.fair_value, m.range[0], m.range[1], s.zip, cal, state.level);
  if (rp) {
    rangeStep = step(++n, `The ${state.level}% range`, `<p class="explain">Two sources of doubt, each scaled by a factor fitted in the backtest so ranges like this
      hold the sale price about ${state.level}% of the time:</p>
      <ul class="explain">
        <li>z = ${f3(rp.z)}: typical miss (log) in past sales ${rp.zipScaled ? `in ZIP ${esc(s.zip)}` : "county-wide (too few in this ZIP)"}; a = ${f3(rp.a)}</li>
        <li>s = ${f3(rp.s)}: how much the comps disagree, spread ÷ value (${money((m.range[1] - m.range[0]) / 2)} ÷ ${money(m.fair_value)}); k = ${f3(rp.k)}</li>
      </ul>
      <p class="explain">h = √((a·z)² + (k·s)²) = √(${f3(rp.a * rp.z)}² + ${f3(rp.k * rp.s)}²) = ${f3(rp.h)}.
        Range = ${money(m.fair_value)} × e<sup>±${f3(rp.h)}</sup> = <b>${money(rp.range[0])} – ${money(rp.range[1])}</b>
        (−${((1 - Math.exp(-rp.h)) * 100).toFixed(1)}% / +${(Math.expm1(rp.h) * 100).toFixed(1)}%).</p>`);
  } else if (range) {
    rangeStep = step(++n, "The range", `<p class="explain">Value ± the spread: ${money(range[0])} – ${money(range[1])}. (No backtest yet to size it.)</p>`);
  }

  return `
    <details class="accuracy breakdown" id="breakdown" ${state.showBreakdown ? "open" : ""}>
      <summary><h3>How we got ${money(m.fair_value)}</h3> <span>every step, from recorded sales to the fair value and range</span></summary>
      ${find}${adjust}${weights}${avg}${methodSteps}${rangeStep}
      <p><a href="drill.html${esc(link())}">Drill into ${money(m.fair_value)}: click any number to see how it was made →</a><br>
        <a href="math.html${esc(link())}">Every number on one page, comp by comp →</a></p>
      <p class="explain">Amounts are rounded to the dollar, so a column can be $1 off its total. Sources: Pasco County Property Appraiser
        sales through ${esc(asOfDate())}${uploadedSales().length ? " plus your Redfin file" : ""}; Zillow ZHVI by ZIP through ${esc(lastIndexMonth(s.zip))}.</p>
    </details>`;
}

function lastIndexMonth(zip) {
  const sr = state.ctx.tindex[zip];
  return sr && sr.length ? monthName(sr[sr.length - 1][0]) : "—";
}

/** Similarity = 1 ÷ (1 + penalty); penalty = Σ weight × difference, less bonuses for the same neighborhood / subdivision. */
function similarityHtml(r) {
  const S = Comps.SIM, s = r.subject, keys = Object.keys(SIM_LABELS);
  const rows = r.comps.map((c) => {
    const p = c.sim_parts || {};
    const bonus = S.same_nbhd * (c.nbhd === s.nbhd ? 1 : 0) + S.same_subdivision * (c.subdivision === s.subdivision ? 1 : 0);
    const pen = sumOf(keys.map((k) => S[k] * (p[k] || 0))) - bonus;
    return `<tr><td>${esc(c.address)}</td>${keys.map((k) => `<td class="num">${(S[k] * (p[k] || 0)).toFixed(2)}</td>`).join("")}
      <td class="num">${bonus ? "−" + bonus.toFixed(2) : "0"}</td><td class="num">${Math.max(pen, 0).toFixed(2)}</td><td class="num">${c.similarity.toFixed(3)}</td>
      <td class="num">${(c.gross_pct / 100).toFixed(3)}</td><td class="num">${c.weight.toFixed(3)}</td></tr>`;
  }).join("");
  return `<details class="sub"><summary class="explain">Similarity scores, comp by comp</summary>
    <p class="explain">Penalty points: size ${S.size} × |log size ratio| ÷ 0.15; age ${S.age} × years apart ÷ 10; lot ${S.lot} × |log lot ratio| ÷ 0.5;
      baths ${S.baths} per bath; pool ${S.pool} × 0.5 if one has a pool and the other doesn't; distance ${S.dist} per mile; how long ago ${S.months} per 6 months;
      bonus −${S.same_nbhd} same appraiser neighborhood, −${S.same_subdivision} same subdivision.</p>
    <div class="table-scroll"><table class="acc">
      <thead><tr><th>Comp</th>${keys.map((k) => `<th class="num">${SIM_LABELS[k]}</th>`).join("")}<th class="num">bonus</th><th class="num">penalty</th>
        <th class="num">similarity</th><th class="num">gross adj.</th><th class="num">weight</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></details>`;
}

// ---------- how accurate is this? (backtest.json from pipeline/backtest.py) ----------
function calibration(method) {
  const c = County.calibration(state.ctx.backtest, method, state.level);
  state.level = c.level;
  return c.cal;
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

// ---------- offer (site/offer.js) ----------
const OFFER_KEY = "hoa:offer";
const offerIn = Object.assign({ dom: "", credit: "10000", rate: "6.5", down: "20", drop: "0.25", margin: "15" },
  (() => { try { return JSON.parse(localStorage.getItem(OFFER_KEY)) || {}; } catch { return {}; } })(),
  { dom: "", lot: "", cpsf: "", carry: "", months: "" });          // per-property: never remembered
const BUILDER_FIELDS = [["lot", "b-lot"], ["cpsf", "b-cpsf"], ["margin", "b-margin"], ["carry", "b-carry"], ["months", "b-months"]];
const num0 = (s) => parseFloat(String(s || "").replace(/[^\d.]/g, ""));
const listPrice = () => num0($("#list").value) || null;
const monthName = (ym) => ym ? new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "";

function offerPlan(r, method) {
  const cal = calibration(method), m = r.methods[method];
  if (!cal || !cal.levels["50"] || m.fair_value == null) return null;
  const range50 = Comps.calibratedRange(m.fair_value, m.range[0], m.range[1], state.ctx.subject.zip, cal, "50");
  return { ...Offer.plan(m.fair_value, range50, listPrice()), fair: m.fair_value, range50 };
}

function offerHtml(r, method) {
  if (!offerPlan(r, method)) return "";
  return `
    <section class="offer" aria-labelledby="offer-h">
      <h3 id="offer-h">Offer</h3>
      <div id="offer-out"></div>
      ${builderHtml()}
      <div class="picker small">
        <label for="dom">Days on market</label>
        <input id="dom" class="narrow" inputmode="numeric" placeholder="optional" value="${esc(offerIn.dom)}">
        <span class="explain">from the listing; list price goes in the box at the top</span>
      </div>
      <div id="market-out"></div>
      <details class="accuracy" id="conc">
        <summary><h3>Seller credit or price cut?</h3> <span>what a concession is worth to you</span></summary>
        <div class="picker small">
          <label for="c-credit">Credit</label><input id="c-credit" class="narrow" inputmode="numeric" value="${esc(offerIn.credit)}">
          <label for="c-rate">Your rate %</label><input id="c-rate" class="tiny" inputmode="decimal" value="${esc(offerIn.rate)}">
          <label for="c-down">Down %</label><input id="c-down" class="tiny" inputmode="decimal" value="${esc(offerIn.down)}">
          <label for="c-drop">Rate cut per point %</label><input id="c-drop" class="tiny" inputmode="decimal" value="${esc(offerIn.drop)}">
        </div>
        <div id="conc-out"></div>
      </details>
    </section>`;
}

function bindOffer(r, method) {
  if (!$("#offer-out")) return;
  const update = () => {
    for (const [k, id] of [["dom", "dom"], ["credit", "c-credit"], ["rate", "c-rate"], ["down", "c-down"], ["drop", "c-drop"]]) offerIn[k] = $("#" + id).value;
    try { const { dom, ...keep } = offerIn; localStorage.setItem(OFFER_KEY, JSON.stringify(keep)); } catch { /* storage off */ }
    renderOffer(r, method);
  };
  ["dom", "c-credit", "c-rate", "c-down", "c-drop"].forEach((id) => $("#" + id).addEventListener("input", update));
  bindBuilder(r, method);
  renderOffer(r, method);
}

function renderOffer(r, method) {
  const p = offerPlan(r, method);
  const list = listPrice();
  const tile = (label, v, note) => `<div class="tile"><div class="label">${label}</div><div class="value small">${money(v)}</div><div class="note">${note}</div></div>`;
  const notes = [];
  if (p.notes.includes("listed_low")) notes.push(`Listed at ${money(list)}, below where 3 in 4 similar homes sold. That's already a good price, and other buyers will see it too: expect competition. Paying up to ${money(p.walkaway)} still matches most past sales.`);
  if (p.notes.includes("listed_high")) notes.push(`Listed at ${money(list)}, above the price 3 in 4 similar homes sold for (${money(p.range50[1])}).`);
  if (p.appraisal_gap.walkaway > 0) notes.push(`Appraisal check: a lender's appraiser works from the same kind of closed sales, so expect an appraisal near ${money(p.fair)}. Above that, the difference is cash you bring: ${money(p.appraisal_gap.walkaway)} at the walk-away price.`);
  $("#offer-out").innerHTML = `
    <div class="tiles">
      ${tile("Opening", p.opening, list && p.opening === list ? "the list price: already below where 3 in 4 similar homes sold" : "about 1 in 4 similar homes sold for less")}
      ${tile("Target", p.target, list && p.target === list ? "the list price, which is at or below our fair value" : "our fair value: half of similar homes sold for less")}
      ${tile("Walk away above", p.walkaway, list && p.walkaway === list && list < p.range50[1] ? "the list price: no reason to pay more" : "3 in 4 similar homes sold for less")}
    </div>
    ${notes.map((n) => `<p class="explain">${esc(n)}</p>`).join("")}
    <p class="explain">These are the ends and middle of the 50% range, which held the sale price for half of past sales. None is above the list price.</p>`;
  if ($("#builder-out")) $("#builder-out").innerHTML = state.builder ? builderOut(p, list) : "";
  $("#market-out").innerHTML = marketHtml(list);
  $("#conc-out").innerHTML = concessionsHtml(p.target);
}

// ---------- time adjustment choice ----------
const trendPct = (nb) => { const t = state.ctx.nbhdTrend && state.ctx.nbhdTrend.nbhds[nb]; return t ? Math.expm1(t.slope) * 100 : null; };

function timeHtml(s) {
  const t = state.ctx.nbhdTrend;
  if (!t) return "";
  const mine = t.nbhds[s.nbhd];
  const note = mine
    ? `${esc(s.nbhd_name || s.nbhd)}: ${pct(trendPct(s.nbhd))} a year vs the ${esc(s.zip)} index, from ${mine.n} sales over ${t.settings.months} months (measured ${pct(Math.expm1(mine.raw) * 100)}, pulled toward 0 by how scattered the sales are).`
    : `${esc(s.nbhd_name || s.nbhd)} has too few sales for its own trend (${t.settings.min_n} needed), so its comps use the ZIP index alone either way.`;
  const opt = (v, label, desc) => `<label class="method"><input type="radio" name="time" value="${v}" ${state.time === v ? "checked" : ""}>
    <span class="m-name">${label}${v === TIME_DEFAULT ? " (best)" : ""}</span><span class="m-value"></span><span class="m-note">${desc}</span></label>`;
  return `<fieldset class="methods"><legend>Bring comp prices to today with</legend>
    ${opt("zip", "ZIP index only", `Zillow's home value index for each comp's ZIP. In past sales, adding neighborhood trends didn't make values closer to sale prices.`)}
    ${opt("nbhd", "ZIP index + neighborhood trend", note)}
  </fieldset>`;
}

// ---------- local price trend from recorded sales (site/trend.js) ----------
function trendFor(group) {
  const { subject, tindex } = state.ctx;
  return Trend.local(subject, allSales(), asOfDate(), group, tindex);
}

/** Default: the narrowest area with enough sales on both sides of the year-over-year check. */
function renderTrend() {
  const box = $("#trend");
  if (!box) return;
  const all = Object.fromEntries(Object.keys(Trend.GROUPS).map((g) => [g, trendFor(g)]));
  const best = ["nbhd", "subdivision", "zip"].find((g) => all[g].yoy.enough) || "zip";
  const g = state.trendGroup || best;
  const s = state.ctx.subject;
  const name = { nbhd: s.nbhd_name || s.nbhd, subdivision: `plat ${s.subdivision}`, zip: s.zip };
  box.innerHTML = `
    <h3>Price trend</h3>
    <div class="levels" role="group" aria-label="Trend area">${Object.entries(Trend.GROUPS).map(([k, v]) =>
      `<button type="button" class="link${k === g ? " on" : ""}" data-trend="${k}" aria-pressed="${k === g}">${v.label}${k === best ? " (best)" : ""}</button>`).join("")}</div>
    ${Trend.html(all[g], { name: name[g], zip: s.zip, tindex: state.ctx.tindex,
      source: `Pasco Property Appraiser sales (market sales only${uploadedSales().length ? ", plus your Redfin file" : ""})` })}`;
  box.querySelectorAll("[data-trend]").forEach((b) => b.onclick = () => { state.trendGroup = b.dataset.trend; renderTrend(); });
}

// ---------- builder floor (new construction; off by default, a reference line only) ----------
function builderHtml() {
  const { subject, meta } = state.ctx;
  const isNew = Comps.looksNew(subject, asOfDate());
  if (!isNew && !state.builderOwned) {
    return `<p class="explain"><button type="button" class="link" id="b-owned">Builder-owned spec home?</button> Show a builder floor.</p>`;
  }
  const field = (id, label, key, ph, cls = "narrow") =>
    `<label for="${id}">${label}</label><input id="${id}" class="${cls}" inputmode="decimal" value="${esc(offerIn[key])}" placeholder="${esc(ph)}">`;
  return `
    <label class="builder"><input type="checkbox" id="opt-builder" ${state.builder ? "checked" : ""}> Builder floor
      <span class="explain">${isNew ? `(new construction: built ${esc(subject.year_built)})` : "(builder-owned)"}: the price below which the builder is unlikely to sell</span></label>
    <div id="builder-in" ${state.builder ? "" : "hidden"}>
      <div class="picker small">
        ${field("b-lot", "Lot cost $", "lot", "e.g. 60000 (ask)")}
        ${field("b-cpsf", "Build cost $/sq ft", "cpsf", "e.g. 140 (ask)", "tiny")}
        ${field("b-margin", "Min margin %", "margin", "15", "tiny")}
      </div>
      <div class="picker small">
        ${field("b-carry", "Carrying cost $/mo", "carry", "optional: interest + taxes")}
        ${field("b-months", "Months unsold", "months", offerIn.dom ? String(Math.round(num0(offerIn.dom) / 30)) : "optional", "tiny")}
      </div>
      <p class="explain">We have no data on lot or build costs: get them from a local builder, an agent, or recent lot sales. The "e.g." values are placeholders, not estimates.</p>
      <div id="builder-out"></div>
    </div>`;
}

function bindBuilder(r, method) {
  const owned = $("#b-owned");
  if (owned) owned.onclick = () => { state.builderOwned = true; state.builder = true; render(); };
  const box = $("#opt-builder");
  if (!box) return;
  box.onchange = () => { state.builder = box.checked; $("#builder-in").hidden = !box.checked; renderOffer(r, method); };
  for (const [key, id] of BUILDER_FIELDS) {
    $("#" + id).addEventListener("input", () => {
      offerIn[key] = $("#" + id).value;
      if (key === "margin") try { localStorage.setItem(OFFER_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(OFFER_KEY) || "{}"), margin: offerIn.margin })); } catch { /* storage off */ }
      renderOffer(r, method);
    });
  }
}

function builderOut(p, list) {
  const s = state.ctx.subject;
  const months = offerIn.months !== "" ? num0(offerIn.months) : (offerIn.dom ? Math.round(num0(offerIn.dom) / 30) : 0);
  const f = Offer.builderFloor({ lot: offerIn.lot === "" ? NaN : num0(offerIn.lot), costPerSqft: num0(offerIn.cpsf), sqft: s.sqft,
    marginPct: offerIn.margin === "" ? 15 : num0(offerIn.margin), carryMonthly: num0(offerIn.carry) || 0, carryMonths: months || 0 });
  const out = [];
  if (!f) out.push(`<p class="explain">Enter the lot cost and build cost per sq ft to estimate the floor.</p>`);
  else {
    out.push(`<p class="builder-line">Fair value ${money(p.fair)} · ${list ? `List ${money(list)} · ` : ""}<strong>Builder's estimated floor ${money(f.floor)}</strong>. Offers below this are unlikely to be accepted.</p>`);
    out.push(`<p class="explain">Cost ${money(f.cost)} = lot ${money(f.lot)} + ${money(num0(offerIn.cpsf))}/sq ft × ${Math.round(s.sqft).toLocaleString()} heated sq ft (${money(f.build)})` +
      (f.carry ? ` + carrying ${money(num0(offerIn.carry))}/mo × ${months} months (${money(f.carry)})` : "") +
      `; floor = cost × ${(1 + f.margin_pct / 100).toFixed(2)} (${f.margin_pct}% minimum margin; builders typically aim for 15–20%). It's a reference line: it doesn't change the comps, fair value or offer prices above.</p>`);
    const msgs = [];
    if (p.fair < f.floor) msgs.push(`Fair value from the comps is below the builder's floor, so the builder likely can't go that low. The deal may hinge on concessions (rate buydown, closing costs) rather than price: see "Seller credit or price cut?" below.`);
    if (list && list >= f.floor && list <= f.floor * 1.03) msgs.push(`The list price is within 3% of the floor: the builder is probably already close to their minimum.`);
    if (list && list < f.floor) msgs.push(`The list price is below this floor estimate: either the builder's costs are lower than entered, or they're under pressure to sell.`);
    if (p.opening < f.floor && p.fair >= f.floor) msgs.push(`The opening offer (${money(p.opening)}) is below the floor; expect a counter near ${money(f.floor)} or an offer of incentives instead.`);
    out.push(...msgs.map((m) => `<p class="explain">${esc(m)}</p>`));
    if (f.carry) out.push(`<p class="explain">Unsold inventory costs the builder every month, which is why their margin tends to shrink the longer a home sits.</p>`);
  }
  // What the recorded sales say about builders in this community (context, measured).
  const low = Comps.builderClosingsLow(s, allSales(), asOfDate());
  const chk = state.ctx.meta.summary && state.ctx.meta.summary.builder_floor_check;
  if (low) {
    out.push(`<p class="explain">From recorded sales: the last ${low.n} builder closings in this subdivision (6 months) went as low as $${low.ppsf.toFixed(0)}/sq ft
      (${esc(low.lowest.address)}, ${money(low.lowest.price)} on ${esc(low.lowest.date)}), which is ${money(low.value)} at this size.` +
      (chk && chk.n ? ` Across ${chk.n.toLocaleString()} Pasco builder closings since ${esc(chk.sales_from)}, ${Math.round(chk.at_or_above_pct)}% came in at or above the low set by earlier ones in their community.` : "") + `</p>`);
  }
  return out.join("");
}

function marketHtml(list) {
  const mk = state.ctx.market, s = state.ctx.subject;
  if (!mk) return "";
  const i = mk.indicators || {};
  const dom = num0(offerIn.dom);
  const rows = [];
  if (i.listing_dom != null) rows.push([`Typical days on market (listings)`, `${Math.round(i.listing_dom)} days`,
    i.listing_dom_yoy_days != null ? `${i.listing_dom_yoy_days >= 0 ? "+" : ""}${Math.round(i.listing_dom_yoy_days)} vs a year ago` : "", `Realtor.com, ${monthName(i.realtor_date)}`]);
  if (i.price_cut_share_pct != null) rows.push(["Listings with a price cut", `${i.price_cut_share_pct.toFixed(0)}%`,
    i.price_cut_share_yoy_pts != null ? `${pct(i.price_cut_share_yoy_pts, 1).replace("%", " pts")} vs a year ago` : "", `Realtor.com, ${monthName(i.realtor_date)}`]);
  if (i.active_listings != null) rows.push(["Active listings", Math.round(i.active_listings).toLocaleString(),
    i.active_listings_yoy_pct != null ? `${pct(i.active_listings_yoy_pct, 0)} vs a year ago` : "", `Realtor.com, ${monthName(i.realtor_date)}`]);
  if (i.avg_sale_to_list_pct != null) rows.push(["Sold for, vs final list price", `${i.avg_sale_to_list_pct.toFixed(1)}%`,
    i.sold_above_list_pct != null ? `${i.sold_above_list_pct.toFixed(0)}% sold above list` : "", `Redfin, 90 days to ${monthName(i.redfin_date)}`]);
  const lines = [];
  if (dom && i.listing_dom) {
    const ratio = dom / i.listing_dom;
    lines.push(ratio >= 1.5 ? `On the market ${dom} days, well past the typical ${Math.round(i.listing_dom)} in ${s.zip}. Sellers of stale listings are often more flexible, which is room to start at the opening price and hold.`
      : ratio <= 0.5 ? `On the market ${dom} days, newer than most (${Math.round(i.listing_dom)} typical). Sellers rarely move much in the first weeks.`
      : `On the market ${dom} days, about typical for ${s.zip} (${Math.round(i.listing_dom)}).`);
  }
  if (list && i.avg_sale_to_list_pct != null) lines.push(`If it sells the way a typical ${s.zip} listing did: ${i.avg_sale_to_list_pct.toFixed(1)}% × ${money(list)} = ${money(list * i.avg_sale_to_list_pct / 100)} (that's the seller's likely expectation, not a value).`);
  const ms = state.ctx.backtest && state.ctx.backtest.market_signals;
  const why = ms && ms.check_median_abs_error_pct
    ? `These don't change the offer numbers. We tested whether ZIP market signals (price cuts, listings, days on market, list prices, each vs a year earlier) predicted whether ${ms.n.toLocaleString()} past sales landed above or below our value: they didn't (on held-back months the typical miss went from ${ms.check_median_abs_error_pct.without_signals.toFixed(1)}% to ${ms.check_median_abs_error_pct.with_signals.toFixed(1)}% with them). The comps and the ZIP home value index already carry it. Use them to judge how much patience the seller has.`
    : "These don't change the offer numbers; use them to judge how much patience the seller has.";
  return `<h4>Market in ${esc(s.zip)}</h4>
    <div class="table-scroll"><table class="acc"><tbody>${rows.map((r) => `<tr><td>${r[0]}<div class="src">${esc(r[3])}</div></td>
      <td class="num">${r[1]}<div class="src">${esc(r[2])}</div></td></tr>`).join("")}</tbody></table></div>
    ${lines.map((l) => `<p class="explain">${esc(l)}</p>`).join("")}
    <p class="explain">${esc(why)}</p>`;
}

function concessionsHtml(price) {
  const credit = num0(offerIn.credit), rate = num0(offerIn.rate), down = num0(offerIn.down), drop = num0(offerIn.drop);
  if (!(credit > 0 && rate >= 0 && down >= 0 && down < 100 && drop >= 0)) return `<p class="explain">Enter a credit, your rate and down payment.</p>`;
  const c = Offer.concessions({ price, credit, downPct: down, ratePct: rate, dropPerPoint: drop });
  const mo = (v) => `${money(v)}/mo`;
  return `<p class="explain">On a ${money(price)} purchase with ${down}% down (loan ${money(c.loan)}, ${mo(c.payment)} principal and interest at ${rate}%), a ${money(credit)} concession is worth:</p>
    <ul class="checks">
      <li><span>As a credit toward closing costs</span><span class="tag">${money(c.closing_costs.cash_saved)} less cash at closing</span></li>
      <li><span>As a rate buydown: ${c.buydown.points.toFixed(2)} points, rate ${c.buydown.new_rate.toFixed(2)}%</span><span class="tag">${mo(c.buydown.monthly_saving)} lower payment, like a ${money(c.buydown.price_cut_equivalent)} price cut</span></li>
      <li><span>As a price cut instead</span><span class="tag">${money(c.price_cut.cash_saved)} less down, ${mo(c.price_cut.monthly_saving)} lower payment</span></li>
    </ul>
    <p class="explain">A price cut also lowers property taxes and keeps the appraisal question simpler; a buydown pays off only if you keep the loan for years.
      Points pricing varies by lender (often about ${drop}% off the rate per point); ask for a quote. Lenders cap seller credits, typically 3–9% of the price depending on the loan and down payment.</p>`;
}

function addressOf(parcelId) {
  const s = allSales().find((x) => x.parcel_id === parcelId);
  return s ? s.address : parcelId;
}

function compRow(c) {
  const flags = c.flags.length ? `<div class="flags">${c.flags.map(esc).join(" · ")}</div>` : "";
  return `<tr class="comp">
      <td class="addr" data-label="">${esc(c.address)}${c.subdivision === state.ctx.subject.subdivision ? ' <span class="tag-sm">same subdivision</span>' : ""}${
        c.source === "redfin_upload" ? ` <span class="tag-sm">from your Redfin file</span>${c.note ? `<div class="flags">${esc(c.note)}</div>` : ""}` : ""}${flags}</td>
      <td data-label="Sold">${esc(c.date)}</td><td class="num" data-label="Price">${money(c.price)}</td>
      <td class="num" data-label="Distance">${c.distance_mi.toFixed(2)} mi</td><td class="num" data-label="Sq ft">${Math.round(c.sqft).toLocaleString()}</td>
      <td class="num" data-label="Built">${c.year_built ?? "—"}</td><td class="num" data-label="Baths">${c.baths ?? "—"}</td><td data-label="Pool">${c.pool ? "yes" : "no"}</td>
      <td class="num strong" data-label="Adjusted">${money(c.adjusted_price)}</td><td class="num" data-label="Weight">${c.weight.toFixed(2)}</td>
      <td class="actions"><a class="link" href="math.html${esc(link(c.parcel_id))}">math</a>
        <button class="link" data-remove="${esc(c.parcel_id)}" ${c.forced ? 'data-forced="1"' : ""} title="Remove this comp" aria-label="Remove ${esc(c.address)}">✕</button></td>
    </tr>`;
}

function runExplain(text, r) {
  const { subject, model, tindex } = state.ctx;
  const key = Comps.normalizeAddress(String(text).split(",")[0]);
  state.explain = Comps.explain(key, subject, allSales(), model, tindex, r, engineOpts());
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
const fromHash = County.decodeSettings(location.hash);
const last = recents()[0];
if (fromHash.a) { addrInput.value = fromHash.a; run(fromHash.a, fromHash); }
else if (last) { addrInput.value = last.value; addrInput.defaultValue = last.value; if (last.list) $("#list").value = last.list; }
