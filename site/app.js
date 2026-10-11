"use strict";

const state = { index: null, sortKey: "zip", sortAsc: true, county: "" };
const $ = (sel) => document.querySelector(sel);

// ---------- formatting ----------
const money = (v) => v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US");
const pct = (v, digits = 1) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
const pts = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)} pts`;
const plain = (v, digits = 1) => v == null ? "—" : v.toFixed(digits);
const days = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)} days`;
const src = (name, date) => name ? `${name}, ${date ?? "—"}` : "no data";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// direction = +1 if a rising value favors buyers, -1 if it favors sellers.
function tone(value, direction) {
  if (value == null || value === 0) return "";
  return value * direction > 0 ? "up-buyer" : "up-seller";
}
function verdictClass(v) {
  if (v === "Buyer leverage rising") return "buyer";
  if (v === "Seller leverage rising") return "seller";
  return "neutral";
}

// ---------- data ----------
async function getJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function init() {
  try {
    state.index = await getJSON("data/index.json");
  } catch (e) {
    $("#detail").hidden = false;
    $("#detail").innerHTML = `<p>No data yet. The weekly build hasn't produced <code>data/index.json</code>.</p>`;
    return;
  }
  $("#built").textContent = `Data built ${state.index.built_at}.`;

  const opts = state.index.zips.map((z) => `<option value="${z.zip}">${esc(z.city)}, ${z.state}</option>`).join("");
  $("#zip-options").innerHTML = opts;
  const counties = [...new Set(state.index.zips.map((z) => `${z.county}, ${z.state}`))].sort();
  $("#county-filter").innerHTML += counties.map((c) => `<option>${esc(c)}</option>`).join("");

  $("#zip-input").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    if (/^\d{5}$/.test(v)) showZip(v);
  });
  $("#county-filter").addEventListener("change", (e) => { state.county = e.target.value; renderTable(); });
  document.querySelectorAll("#zip-table th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.key;
    state.sortAsc = state.sortKey === k ? !state.sortAsc : true;
    state.sortKey = k;
    renderTable();
  }));
  window.addEventListener("hashchange", fromHash);
  bindNeighborhoods();

  renderTable();
  fromHash();
}

function fromHash() {
  const z = location.hash.replace("#", "");
  if (/^\d{5}$/.test(z)) { $("#zip-input").value = z; showZip(z); }
  const n = /^n=(.+)$/.exec(z);
  if (n) { const name = decodeURIComponent(n[1]); $("#nb-input").value = name; showNeighborhood(name); }
}

// ---------- neighborhood lookup (county appraiser neighborhoods; site/trend.js) ----------
const COUNTY = "pasco";                       // the counties with sale records (more to come)
const cbase = `data/counties/${COUNTY}/`;
const nb = { data: null, items: [], active: -1 };

async function loadCounty() {
  if (nb.data) return nb.data;
  const [nbhds, meta, tindex, trend] = await Promise.all(["nbhds.json", "meta.json", "tindex.json", "nbhd_trend.json"]
    .map((f) => getJSON(cbase + f).catch(() => null)));
  if (!nbhds || !meta) throw new Error("county data missing");
  nb.data = { nbhds, meta, tindex: tindex || {}, trend: trend && trend.nbhds, sales: new Map() };
  return nb.data;
}

function fromTable(t) {
  return t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
}

async function salesFor(zips) {
  const d = nb.data;
  await Promise.all(zips.filter((z) => !d.sales.has(z)).map(async (z) =>
    d.sales.set(z, await getJSON(`${cbase}sales/${z}.json`).then(fromTable).catch(() => []))));
  return zips.flatMap((z) => d.sales.get(z));
}

function bindNeighborhoods() {
  const input = $("#nb-input"), list = $("#nb-list");
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); nb.active = -1; };
  const show = () => {
    if (!nb.items.length) return close();
    list.innerHTML = nb.items.map((h, i) => `<li role="option" id="nb-${i}" data-i="${i}" aria-selected="${i === nb.active}">
      <span class="main">${esc(h.name)}</span><span class="tag">${esc(h.zips.join(", "))} · ${h.parcels.toLocaleString()} parcels</span></li>`).join("");
    list.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  const choose = (h) => { input.value = h.name; close(); location.hash = "n=" + encodeURIComponent(h.name); };
  input.addEventListener("input", async () => {
    try { await loadCounty(); } catch { $("#nb-status").textContent = "Neighborhood data isn't published yet."; return; }
    nb.items = Trend.findNeighborhoods(input.value, nb.data.nbhds); nb.active = -1; show();
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      nb.active = (nb.active + (e.key === "ArrowDown" ? 1 : -1) + nb.items.length) % nb.items.length; show();
      input.setAttribute("aria-activedescendant", `nb-${nb.active}`);
    } else if (e.key === "Enter" && nb.active >= 0) { e.preventDefault(); choose(nb.items[nb.active]); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choose(nb.items[+li.dataset.i]); }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
  $("#nb-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    if (location.hash === "#n=" + encodeURIComponent(v)) showNeighborhood(v); else location.hash = "n=" + encodeURIComponent(v);
  });
}

async function showNeighborhood(text) {
  const box = $("#detail"), status = $("#nb-status");
  let d;
  try { d = await loadCounty(); } catch { status.textContent = "Neighborhood data isn't published yet. The weekly build creates it."; return; }
  const hits = Trend.findNeighborhoods(text, d.nbhds);
  const exact = hits.find((h) => h.name.toUpperCase() === text.trim().toUpperCase());
  const h = exact || (hits.length === 1 ? hits[0] : null);
  if (!h) {
    status.innerHTML = hits.length
      ? `Several neighborhoods match: ${hits.map((x) => `<a href="#n=${encodeURIComponent(x.name)}">${esc(x.name)}</a>`).join(", ")}.`
      : `No Pasco appraiser neighborhood matches “${esc(text)}”. Try part of the name, or value an address in it.`;
    return;
  }
  status.textContent = "Loading sales…";
  const sales = await salesFor(h.zips);
  status.textContent = "";
  const codes = new Set(h.codes), zip = h.zips[0];
  const tr = Trend.local({ zip }, sales, d.meta.latest_sale, "nbhd", d.tindex, (s) => codes.has(s.nbhd));
  const rel = h.codes.map((c) => d.trend && d.trend[c] ? [c, d.trend[c]] : null).filter(Boolean);
  const relText = rel.length
    ? `Over the last 24 months, same-house prices here moved ${rel.map(([c, t]) => `${pct(Math.expm1(t.slope) * 100)} a year` +
        (rel.length > 1 ? ` (${esc(c)})` : "") + ` relative to the ${esc(zip)} index, from ${t.n} sales`).join("; ")}
        (measured, then pulled toward 0 by how scattered the sales are; when valuing a home this is an option, off by default, because it didn't improve past valuations).`
    : `Too few sales over 24 months for a trend relative to the ZIP index.`;
  const zrec = state.index && state.index.zips.find((z) => z.zip === zip);
  const zipText = zrec ? `ZIP ${zip} overall: typical value ${pct(zrec.zhvi_yoy_pct)} over a year, Zillow forecast ${pct(zrec.forecast_12m_pct)} for the next 12 months,
    ${zrec.price_drops_pct == null ? "" : zrec.price_drops_pct.toFixed(0) + "% of listings with a price cut, "}inventory ${pct(zrec.inventory_yoy_pct, 0)} vs last year; read: ${esc(zrec.verdict)}.` : "";
  box.hidden = false;
  box.innerHTML = `
    <div class="detail-head">
      <div><h2>${esc(h.name)}</h2><span class="place">Pasco appraiser neighborhood ${esc(h.codes.join(", "))} · ZIP ${esc(h.zips.join(", "))} · ${h.parcels.toLocaleString()} parcels</span></div>
    </div>
    <h3>Sale-price trend</h3>
    ${Trend.html(tr, { name: h.name, zip, tindex: d.tindex })}
    <p class="explain">${relText}</p>
    ${zipText ? `<h3>Market around it</h3><p class="explain">${zipText} <a href="#${esc(zip)}">Listings, price cuts and days on market for ${esc(zip)}</a>.</p>` : ""}
    <p class="explain"><a href="value.html">Value a home in ${esc(h.name)}</a> to see its comps and offer range.</p>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- overview table ----------
function renderTable() {
  let rows = state.index.zips.filter((z) => !state.county || `${z.county}, ${z.state}` === state.county);
  const k = state.sortKey, dir = state.sortAsc ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
  document.querySelectorAll("#zip-table th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === k);
    th.classList.toggle("asc", th.dataset.key === k && state.sortAsc);
  });
  $("#zip-table tbody").innerHTML = rows.map((z) => `
    <tr data-zip="${z.zip}">
      <td>${z.zip}</td><td>${esc(z.city)}</td><td>${esc(z.county)}, ${z.state}</td>
      <td class="num">${money(z.zhvi)}</td>
      <td class="num ${tone(z.zhvi_yoy_pct, -1)}">${pct(z.zhvi_yoy_pct)}</td>
      <td class="num ${tone(z.forecast_12m_pct, -1)}">${pct(z.forecast_12m_pct)}</td>
      <td class="num">${z.price_drops_pct == null ? "—" : z.price_drops_pct.toFixed(1) + "%"}</td>
      <td class="num ${tone(z.inventory_yoy_pct, 1)}">${pct(z.inventory_yoy_pct, 0)}</td>
      <td><span class="verdict ${verdictClass(z.verdict)}">${esc(z.verdict)}</span></td>
    </tr>`).join("");
  document.querySelectorAll("#zip-table tbody tr").forEach((tr) =>
    tr.addEventListener("click", () => { location.hash = tr.dataset.zip; }));
}

// ---------- ZIP detail ----------
async function showZip(zip) {
  const box = $("#detail");
  box.hidden = false;
  if (!state.index.zips.some((z) => z.zip === zip)) {
    box.innerHTML = `<p>${zip} isn't in a covered area yet. Add its county (or the ZIP) to <code>coverage.yaml</code>.</p>`;
    return;
  }
  let rec;
  try { rec = await getJSON(`data/zips/${zip}.json`); }
  catch (e) { box.innerHTML = `<p>Couldn't load data for ${zip}.</p>`; return; }

  const i = rec.indicators, f = rec.zillow_forecast, s = rec.signal;
  const tile = (label, value, note = "", cls = "") =>
    `<div class="tile"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="note">${note}</div></div>`;

  box.innerHTML = `
    <div class="detail-head">
      <div><h2>${rec.zip}</h2><span class="place">${esc(rec.city)} · ${esc(rec.county)}, ${rec.state}</span></div>
      <span class="verdict ${verdictClass(s.verdict)}">${esc(s.verdict)}</span>
    </div>

    <div class="tiles">
      ${tile("Typical home value", money(i.zhvi), `Zillow, ${i.zhvi_date ?? "—"}`)}
      ${tile("1-year change", pct(i.zhvi_yoy_pct), `3-mo ${pct(i.zhvi_3m_pct)} · vs 2019 ${pct(i.zhvi_vs_2019_pct, 0)}`, tone(i.zhvi_yoy_pct, -1))}
      ${tile("Zillow 12-month forecast", pct(f?.forecast_12m_pct), f ? `to ${f.target_date_12m?.slice(0, 7)}` : "not published", tone(f?.forecast_12m_pct, -1))}
      ${tile("Listings with price cuts", i.cuts_pct == null ? "—" : i.cuts_pct.toFixed(1) + "%", `${pts(i.cuts_yoy_pts)} vs a year ago · ${src(i.cuts_source, i.cuts_date)}`, tone(i.cuts_yoy_pts, 1))}
      ${tile("Homes for sale", i.inv == null ? "—" : Math.round(i.inv).toLocaleString(), `${pct(i.inv_yoy_pct, 0)} vs last yr · ${pct(i.inv_vs_2019_pct, 0)} vs 2019 · ${src(i.inv_source, i.inv_date)}`, tone(i.inv_yoy_pct, 1))}
      ${tile("Median days on market", i.dom == null ? "—" : Math.round(i.dom), `${days(i.dom_yoy_days)} vs a year ago · ${src(i.dom_source, i.dom_date)}`, tone(i.dom_yoy_days, 1))}
      ${tile("Sale-to-list", i.avg_sale_to_list_pct == null ? "—" : i.avg_sale_to_list_pct.toFixed(1) + "%", `${pts(i.sale_to_list_yoy_pts)} vs a year ago · ${src("Redfin", i.redfin_date)}`, tone(i.sale_to_list_yoy_pts, -1))}
      ${tile("Median sale price", money(i.median_sale_price), `${pct(i.median_sale_price_yoy_pct)} vs last yr · ${money(i.median_ppsf)}/sf · ${src("Redfin", i.redfin_date)}`, tone(i.median_sale_price_yoy_pct, -1))}
    </div>

    <h3>How the read is scored</h3>
    <ul class="checks">
      ${s.checks.map((c) => `<li><span>${esc(c.label)}: ${c.value > 0 ? "+" : ""}${plain(c.value)}${c.unit === "%" ? "%" : " " + c.unit}</span>
        <span class="tag ${c.score > 0 ? "up-buyer" : c.score < 0 ? "up-seller" : ""}">${c.score > 0 ? "favors buyers" : c.score < 0 ? "favors sellers" : "neutral"}</span></li>`).join("")}
    </ul>
    <p class="explain">Each leading indicator is compared with the same month a year earlier so seasonal swings don't count. Two or more net signals in one direction set the read. Each tile names its source and month. Redfin figures are rolling 90-day windows; its ZIP file currently ends ${i.redfin_date ?? "—"}, so newer Realtor.com listing data is used where available.</p>

    <div class="charts">
      ${chart("Typical home value (Zillow)", rec.series.zhvi, money)}
      ${chart("Listings with price cuts", rec.series.price_drops_pct, (v) => v.toFixed(0) + "%")}
      ${chart("Active listings (Realtor.com)", rec.series.active_listings, (v) => Math.round(v).toLocaleString())}
      ${chart("Inventory (Redfin)", rec.series.inventory, (v) => Math.round(v).toLocaleString())}
      ${chart("Median days on market", rec.series.median_dom, (v) => Math.round(v))}
      ${chart("Sale-to-list ratio", rec.series.sale_to_list_pct, (v) => v.toFixed(1) + "%")}
      ${chart("Median sale price (Redfin)", rec.series.median_sale_price, money)}
    </div>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- tiny SVG line chart ----------
function chart(title, points, fmt) {
  if (!points || points.length < 2) {
    return `<div class="chart"><h3>${title}</h3><p class="empty">No data for this ZIP.</p></div>`;
  }
  const W = 320, H = 150, L = 52, R = 8, T = 8, B = 20;
  const vals = points.map((p) => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (k) => L + (k / (points.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = points.map((p, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const grid = ticks.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
    <text class="axis" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${fmt(t)}</text>`).join("");
  const first = points[0][0].slice(0, 4), last = points[points.length - 1][0];
  const latest = points[points.length - 1][1];
  return `<div class="chart"><h3>${title} <span class="explain">· latest ${fmt(latest)}</span></h3>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}, ${first} to ${last}">
      ${grid}
      <path class="series" d="${path}"/>
      <text class="axis" x="${L}" y="${H - 4}">${first}</text>
      <text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${last}</text>
    </svg></div>`;
}

init();
