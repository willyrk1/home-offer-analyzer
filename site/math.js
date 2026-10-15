"use strict";
/* Every number behind a fair value (math.html). Values the home exactly as the value page does
   (same files via county.js, same settings from the link, same engine in comps.js), then prints
   the arithmetic: no new calculations, only the engine's own numbers laid out step by step. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => v == null ? "—" : (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
const x = (v, d = 4) => v.toFixed(d).replace("-", "−");
const sg = (v, d = 4) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const pct = (v, d = 2) => `${sg(v, d)}%`;
const num = (v) => Math.round(v).toLocaleString("en-US");
const monthName = (ym) => ym ? new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "";
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const DAY = 86400000;
const METHOD_NAMES = { comps: "Adjusted comps", assessed: "Appraiser ratio", blend: "Blend of both" };

/** One row of a step: label, then the equation. kind: "sub" (indented) or "total" (ruled, bold). */
const row = (label, eq, kind = "") => `<dt class="${kind}">${label}</dt><dd class="${kind}">${eq}</dd>`;
const card = (title, body, attrs = "") => `<section class="detail"${attrs}><h2>${title}</h2>${body}</section>`;
const eqs = (rows) => `<dl class="eqs">${rows.join("")}</dl>`;
/** Steps the chosen method doesn't use are still shown, marked so. */
const USES = { comps: ["comps"], assessed: ["assessed"], blend: ["comps", "assessed", "blend"] };
const unused = (ctx, step) => USES[ctx.method].includes(step) ? "" : ` <span class="tag-sm">not used: method is ${METHOD_NAMES[ctx.method].toLowerCase()}</span>`;

const settings = County.decodeSettings(location.hash);

async function main() {
  const back = "value.html" + (settings.a ? County.encodeSettings({ ...settings, focus: null }) : "");
  $("#back").href = back; $("#nav-value").href = back;
  $("#to-drill").href = "drill.html" + County.encodeSettings({ ...settings, focus: null });
  if (!settings.a) {
    $("#status").innerHTML = `Pick a home on the <a href="value.html">value page</a>, then follow "Every number" from there.`;
    return;
  }
  const ctx = await County.valueFromLink(settings);
  if (ctx.error) { $("#status").textContent = ctx.error; return; }
  const { r, subject } = ctx;

  $("#status").textContent = "";
  if (!r.comps.length || r.fair_value == null) { $("#out").innerHTML = card("No comps", `<p class="explain">No qualifying sales were found for this home.</p>`); return; }
  $("#out").innerHTML = [resultCard(ctx), houseCard(ctx), searchCard(ctx), legend(),
    ...r.comps.map((c, i) => compCard(ctx, c, i)), compsValueCard(ctx), assessedCard(ctx), blendCard(ctx), rangeCard(ctx)].join("");
  $("#sources").innerHTML = sources(ctx);
  document.title = `Every Number · ${subject.address}`;
  if (settings.focus) {
    const el = document.getElementById("comp-" + settings.focus);
    if (el) { el.classList.add("focus"); el.scrollIntoView({ block: "start" }); }
  }
}

// ---------- the answer, as shown on the value page ----------
function finalRange(ctx) {
  const m = ctx.r.methods[ctx.method];
  const p = ctx.cal && Comps.calibratedRangeParts(m.fair_value, m.range[0], m.range[1], ctx.subject.zip, ctx.cal, ctx.level);
  return { m, p, range: p ? p.range : m.range };
}

function resultCard(ctx) {
  const { m, range } = finalRange(ctx);
  const o = ctx.opts, why = settings.method === ctx.method ? "you picked" : ctx.method === County.bestMethod(ctx.backtest) ? "most accurate in the backtest" : "the only one available";
  const notes = [
    `method: ${METHOD_NAMES[ctx.method].toLowerCase()} (${why})`,
    `${ctx.cal ? ctx.level + "%" : "±spread"} range`,
    `time: ${ctx.local ? "ZIP index + neighborhood trend" : "ZIP index only"}`,
    o.includeDistressed ? "distressed sales at half weight" : "market sales only",
    o.excluded.length ? `${o.excluded.length} comp${o.excluded.length > 1 ? "s" : ""} removed by you` : "",
    o.forced.length ? `${o.forced.length} added by you` : "",
    ctx.added.length ? `${ctx.added.length} sales from your Redfin file` : "",
  ].filter(Boolean);
  return card(`${esc(ctx.subject.address)}`, `<p class="result-line">Fair value <b>${money(m.fair_value)}</b>${range
    ? ` · ${ctx.cal ? ctx.level + "% " : ""}range ${money(range[0])} – ${money(range[1])}` : ""}</p>
    <p class="explain">${esc(ctx.subject.city)} ${esc(ctx.subject.zip)} · parcel ${esc(ctx.subject.parcel_id)} · as of ${esc(ctx.asOf)}. Settings from the value page: ${esc(notes.join("; "))}.</p>`);
}

function facts(h) {
  return [`${num(h.sqft)} sq ft`, `built ${h.year_built ?? "—"}`, `${h.baths ?? "—"} baths`, `${h.stories ?? "—"} ${h.stories === 1 ? "story" : "stories"}`,
    `grade ${h.quality ?? "—"}`, h.pool ? "pool" : "no pool", `lot ${h.lot_acres ?? "—"} ac`].join(" · ");
}

function houseCard(ctx) {
  const s = ctx.subject;
  return card("This house", eqs([
    row("Features", facts(s)),
    row("Just value", `${money(s.just_value)} (Pasco appraiser, Jan 1)`),
    row("Neighborhood", `${esc(s.nbhd_name || s.nbhd)} (${esc(s.nbhd)}) · subdivision ${esc(s.subdivision)}`),
  ]));
}

// ---------- 1. find the comps ----------
function searchCard(ctx) {
  const { r, subject: s, opts } = ctx;
  const lo = s.sqft * (1 - Comps.SIZE_LIMIT), hi = s.sqft * (1 + Comps.SIZE_LIMIT);
  const byId = (id) => (ctx.sales.find((x) => x.parcel_id === id) || {}).address || id;
  const rows = [
    row("Candidates", `${num(r.pool_size)} ${esc(String(s.property_type).replace("_", " "))} sales (${opts.includeDistressed ? "market + distressed" : "market only"}) in ${esc(s.zip)} and neighboring ZIPs, latest per house, this house excluded`),
    row("Search stopped at", `${esc(r.search.area)}, sold in the last ${r.search.months} months${r.search.thin ? " (few sales: widest search)" : ""}`),
    row("Size limit", `${num(s.sqft)} × ${x(1 - Comps.SIZE_LIMIT, 2)} to × ${x(1 + Comps.SIZE_LIMIT, 2)} = ${num(lo)} – ${num(hi)} sq ft`),
    row("Kept", `the ${Comps.MAX_COMPS} most similar of those (at least ${Comps.MIN_COMPS} needed)${opts.forced.length ? `, plus ${opts.forced.length} added by you` : ""}`),
  ];
  if (opts.excluded.length) rows.push(row("Removed by you", opts.excluded.map((id) => esc(byId(id))).join("; ")));
  return card("1. Find the comps", eqs(rows));
}

function legend() {
  return `<p class="explain">Each comp below: bring its price to today, adjust it for every difference from this house, score how similar it is, and weight it.
    Feature lines read <i>effect per unit × difference (this house − comp) = change in log price → price change</i>, where price change = e<sup>change</sup> − 1;
    units are log sq ft, years, log acres, baths, yes = 1 and grade steps. Gross = the price changes added with signs dropped.</p>`;
}

// ---------- 2. each comp ----------
function zhviStep(ctx, c) {
  const s = ctx.tindex[c.zip];
  if (!s || !s.length) return `× 1 (no index for ZIP ${esc(c.zip)})`;
  const month = c.date.slice(0, 7);
  let then = null;
  for (const p of s) { if (p[0] <= month) then = p; else break; }
  if (!then) return `× 1 (no index for ${esc(month)})`;
  const last = s[s.length - 1];
  return `ZHVI ${esc(c.zip)}: ${money(last[1])} ${monthName(last[0])} ÷ ${money(then[1])} ${monthName(then[0])} = ${x(last[1] / then[1])}`;
}

function describeDiff(a, s, c, asOf) {
  switch (a.feature) {
    case "ln_sqft": return `${num(s.sqft)} vs ${num(c.sqft)} sq ft`;
    case "age": return `built ${s.year_built} vs ${c.year_built}; this house's age as of ${esc(asOf)}, the comp's in its sale year`;
    case "new": return a.difference > 0 ? "this house is new" : "comp is new";
    case "ln_lot": return `${s.lot_acres} vs ${c.lot_acres} ac`;
    case "baths": return `${s.baths} vs ${c.baths} baths`;
    case "pool": return a.difference > 0 ? "this house has a pool" : "comp has a pool";
    case "two_story": return a.difference > 0 ? "this house is two-story" : "comp is two-story";
    case "quality": return `grade ${s.quality} vs ${c.quality}`;
    default: return "";
  }
}

function similarityRows(ctx, c) {
  const S = Comps.SIM, s = ctx.subject, p = c.sim_parts;
  const subjLot = s.lot_acres ?? 0.15, subjBaths = s.baths ?? 2;
  const days = Math.round((Date.parse(ctx.asOf) - Date.parse(c.date)) / DAY);
  const part = (k, how) => row(k === "months" ? "how long ago" : k === "dist" ? "distance" : k, `${how} = ${x(p[k], 3)} × ${S[k]} = ${x(S[k] * p[k], 3)}`, "sub");
  const nb = c.nbhd === s.nbhd, sd = c.subdivision === s.subdivision;
  const bonus = (nb ? S.same_nbhd : 0) + (sd ? S.same_subdivision : 0);
  const penalty = sum(["size", "age", "lot", "baths", "pool", "dist", "months"].map((k) => S[k] * p[k])) - bonus;
  return [
    row("Similarity", "penalty points for each difference:"),
    part("size", `|ln(${num(c.sqft)} ÷ ${num(s.sqft)})| ÷ 0.15`),
    part("age", `|${c.year_built ?? s.year_built} − ${s.year_built}| ÷ 10`),
    part("lot", `|ln(${c.lot_acres ?? subjLot} ÷ ${subjLot})| ÷ 0.5`),
    part("baths", `|${c.baths ?? subjBaths} − ${subjBaths}|`),
    part("pool", Boolean(c.pool) === Boolean(s.pool) ? "both the same" : "one has a pool"),
    part("dist", `${x(c.distance_mi, 3)} mi`),
    part("months", `${days} days ÷ 30.4 ÷ 6`),
    row("bonus", bonus ? [nb ? `same neighborhood −${S.same_nbhd}` : "", sd ? `same subdivision −${S.same_subdivision}` : ""].filter(Boolean).join(", ") : "none", "sub"),
    row("penalty", `sum = ${x(penalty, 3)}${penalty < 0 ? " (counts as 0)" : ""}`, "sub"),
    row("similarity", `1 ÷ (1 + ${x(Math.max(penalty, 0), 4)}) = ${x(c.similarity)}`, "total"),
  ];
}

function compCard(ctx, c, i) {
  const s = ctx.subject;
  const tags = [c.sale_class, c.forced ? "added by you" : "", c.source === "redfin_upload" ? "from your Redfin file" : "",
    c.subdivision === s.subdivision ? "same subdivision" : ""].filter(Boolean);
  const rows = [row("Sale", `${esc(c.date)} · ${money(c.price)} · ${esc(tags.join(" · "))} · ${x(c.distance_mi, 2)} mi away`),
    row("Features", facts(c))];
  const zipFactor = c.time_factor / c.local_factor;
  if (c.local_factor !== 1) {
    const slope = ctx.local[c.nbhd].slope, years = (Date.parse(ctx.asOf) - Date.parse(c.date)) / DAY / 365.25;
    rows.push(row("Time", `${zhviStep(ctx, c)}`),
      row("Neighborhood", `${esc(c.nbhd)} trend: e^(${sg(slope)} per yr × ${x(years, 3)} yr) = ${x(c.local_factor)}`),
      row("Today", `${money(c.price)} × ${x(zipFactor)} × ${x(c.local_factor)} = ${money(c.time_adjusted)}`, "total"));
  } else {
    rows.push(row("Time", zhviStep(ctx, c)),
      row("Today", `${money(c.price)} × ${x(c.time_factor)} = ${money(c.time_adjusted)}`, "total"));
  }
  rows.push(row("Adjustments", c.adjustments.length ? "" : "none: same on every feature"));
  for (const a of c.adjustments) {
    rows.push(row(esc(a.label), `${describeDiff(a, s, c, ctx.asOf)}: effect per unit ${sg(a.coef)} × difference ${sg(a.difference)} = ${sg(a.coef * a.difference, 5)}
      → price change ${pct(a.pct)} (${a.dollars >= 0 ? "+" : ""}${money(a.dollars)})`, "sub"));
  }
  const logSum = sum(c.adjustments.map((a) => a.coef * a.difference));
  rows.push(row("Adjusted", `${money(c.time_adjusted)} × e^(${sg(logSum, 5)} total) = <b>${money(c.adjusted_price)}</b> · net ${pct(c.net_pct)}
    · gross ${c.adjustments.map((a) => x(Math.abs(a.pct), 2)).join(" + ") || "0"} = ${x(c.gross_pct, 2)}%`, "total"));
  rows.push(...similarityRows(ctx, c));
  rows.push(row("Weight", `similarity ${x(c.similarity)} ÷ (1 + gross ${x(c.gross_pct / 100)})${c.sale_class === "distressed" ? ` × ${Comps.DISTRESSED_WEIGHT} distressed` : ""} = <b>${x(c.weight)}</b>`, "total"));
  return card(`2.${i + 1} ${esc(c.address)} <span class="num">${money(c.adjusted_price)}</span>`, eqs(rows), ` id="comp-${esc(c.parcel_id)}"`);
}

// ---------- 3–5. combine ----------
function compsValueCard(ctx) {
  const comps = ctx.r.comps, m = ctx.r.methods.comps;
  const W = sum(comps.map((c) => c.weight)), WP = sum(comps.map((c) => c.weight * c.adjusted_price));
  const SS = sum(comps.map((c) => c.weight * (c.adjusted_price - m.fair_value) ** 2));
  const share = (c) => `${x(c.weight / W * 100, 1)}%`;
  return card("3. Adjusted comps value" + unused(ctx, "comps"), eqs([
    ...comps.map((c) => row(esc(c.address), `weight ${x(c.weight)} × ${money(c.adjusted_price)} = ${money(c.weight * c.adjusted_price)} (${share(c)} of the weight)`, "sub")),
    row("Sums", `Σ weight = ${x(W)} · Σ weight × price = ${money(WP)}`),
    row("Value", `${money(WP)} ÷ ${x(W)} = <b>${money(m.fair_value)}</b>`, "total"),
    row("Spread", `√(Σ weight × (price − value)² ÷ Σ weight) = √(${num(SS)} ÷ ${x(W)}) = ±${money(m.fair_value - m.range[0])}`),
  ]));
}

function assessedCard(ctx) {
  const a = ctx.r.methods.assessed, comps = ctx.r.comps;
  if (a.fair_value == null) return card("4. Appraiser-ratio value", `<p class="explain">Not available for this home: ${esc(a.reason || "no appraiser values")}.</p>`);
  const used = new Set(a.used);
  const withJV = comps.filter((c) => c.just_value);
  const ratios = withJV.map((c) => c.time_adjusted / c.just_value).sort((p, q) => p - q);
  const k = Math.floor(ratios.length / 2), med = ratios.length % 2 ? ratios[k] : (ratios[k - 1] + ratios[k]) / 2;
  const w = (c) => c.similarity * (c.sale_class === "distressed" ? Comps.DISTRESSED_WEIGHT : 1);
  const kept = comps.filter((c) => used.has(c.parcel_id));
  const W = sum(kept.map(w)), WR = sum(kept.map((c) => w(c) * c.time_adjusted / c.just_value));
  const SS = sum(kept.map((c) => w(c) * (a.just_value * c.time_adjusted / c.just_value - a.fair_value) ** 2));
  return card("4. Appraiser-ratio value" + unused(ctx, "assessed"), eqs([
    ...withJV.map((c) => row(esc(c.address), `${money(c.time_adjusted)} today ÷ ${money(c.just_value)} just value = ${x(c.time_adjusted / c.just_value)}${used.has(c.parcel_id)
      ? ` · weight ${x(w(c))}` : ` <span class="thin">(dropped: outside the band)</span>`}`, "sub")),
    row("Band", `median ${x(med)} ÷ 1.5 to × 1.5 = ${x(med / 1.5)} – ${x(med * 1.5)}`),
    row("Ratio", `Σ weight × ratio ÷ Σ weight = ${x(WR)} ÷ ${x(W)} = ${x(a.ratio, 6)}`),
    row("Value", `${money(a.just_value)} × ${x(a.ratio, 6)} = <b>${money(a.fair_value)}</b>`, "total"),
    row("Spread", `√(Σ weight × (just value × ratio − value)² ÷ Σ weight) = √(${num(SS)} ÷ ${x(W)}) = ±${money(a.fair_value - a.range[0])}`),
  ]) + `<p class="explain">Weight here is the similarity alone${comps.some((c) => c.sale_class === "distressed") ? " (× 0.5 distressed)" : ""}: nothing is adjusted, so there's no gross-adjustment penalty.</p>`);
}

function blendCard(ctx) {
  const { comps: c, assessed: a, blend: b } = ctx.r.methods;
  if (b.fair_value == null) return "";
  return card("5. Blend" + unused(ctx, "blend"), eqs([
    row("Value", `(${money(c.fair_value)} + ${money(a.fair_value)}) ÷ 2 = <b>${money(b.fair_value)}</b>`, "total"),
    row("Spread", `(±${money(c.fair_value - c.range[0])} + ±${money(a.fair_value - a.range[0])}) ÷ 2 = ±${money(b.fair_value - b.range[0])}`),
  ]));
}

function rangeCard(ctx) {
  const { m, p, range } = finalRange(ctx);
  const n = ctx.r.methods.blend.fair_value != null ? 6 : ctx.r.methods.assessed.fair_value != null ? 5 : 4;
  if (!p) return card(`${n}. The range`, eqs([row("Range", `${money(m.fair_value)} ± spread = ${money(range[0])} – ${money(range[1])} (no backtest yet to size it)`, "total")]));
  const spread = (m.range[1] - m.range[0]) / 2;
  return card(`${n}. The ${ctx.level}% range (${METHOD_NAMES[ctx.method].toLowerCase()})`, eqs([
    row("z", `typical log miss in past sales, ${p.zipScaled ? `ZIP ${esc(ctx.subject.zip)}` : "county-wide (too few in this ZIP)"} = ${x(p.z)}`),
    row("s", `spread ÷ value = ${money(spread)} ÷ ${money(m.fair_value)} = ${x(p.s)}${p.s === 0.005 ? " (floor)" : ""}`),
    row("a, k", `fitted in the backtest for ${ctx.level}% = ${x(p.a, 3)}, ${x(p.k, 3)}`),
    row("h", `√((a × z)² + (k × s)²) = √(${x(p.a * p.z)}² + ${x(p.k * p.s)}²) = ${x(p.h)}`),
    row("Range", `${money(m.fair_value)} × e^(−${x(p.h)}) to × e^(+${x(p.h)}) = <b>${money(range[0])} – ${money(range[1])}</b>
      (${pct(-(1 - Math.exp(-p.h)) * 100, 1)} / ${pct(Math.expm1(p.h) * 100, 1)})`, "total"),
  ]) + `<p class="explain">In past sales, ranges sized this way held the sale price ${Math.round(ctx.cal.levels[ctx.level].check_coverage_pct)}% of the time.</p>`);
}

function sources(ctx) {
  const m = ctx.model, s = ctx.tindex[ctx.subject.zip], bt = ctx.backtest;
  const lastAdded = ctx.added.length ? ctx.added.reduce((a, x) => (x.date > a ? x.date : a), "") : null;
  return `Sources: Pasco County Property Appraiser parcels and recorded sales through ${esc(ctx.meta.latest_sale)}${lastAdded
    ? `, plus ${ctx.added.length} sales from your Redfin file through ${esc(lastAdded)} (kept in this browser only)` : ""};
    feature effects fitted on ${m.n_sales.toLocaleString()} Pasco market sales (${esc(m.window[0])} to ${esc(m.window[1])});
    Zillow home value index (ZHVI) by ZIP through ${s && s.length ? monthName(s[s.length - 1][0]) : "—"}${bt ? `; ranges fitted in the backtest on sales through ${esc(bt.sales_to)}` : ""}.
    Dollar amounts are rounded; the math uses full precision, so a line can be $1 off.`;
}

main().catch((e) => { $("#status").textContent = "Something went wrong: " + e.message; });
