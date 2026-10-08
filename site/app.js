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

  renderTable();
  fromHash();
}

function fromHash() {
  const z = location.hash.replace("#", "");
  if (/^\d{5}$/.test(z)) { $("#zip-input").value = z; showZip(z); }
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
