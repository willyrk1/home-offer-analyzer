"use strict";
/* Drill-down (drill.html): one equation for the fair value; click any number to open the equation
   that made it, and so on down to the recorded data. Values the home exactly as the value page does
   (County.valueFromLink); every number shown is the engine's own, only laid out as a tree. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
const x = (v, d = 4) => v.toFixed(d).replace("-", "−");
const num = (v) => Math.round(v).toLocaleString("en-US");
const monthName = (ym) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const DAY = 86400000;
const METHOD_NAMES = { comps: "adjusted comps", assessed: "just-value ratio", blend: "blend of both" };

// ---------- numbers ----------
/** A number made from others: what it is, the equation (strings and numbers), and its value as shown. */
const calc = (text, what, parts) => ({ text, what, parts });
/** A number taken from the data (or a fixed setting): what it is and where it comes from. */
const data = (text, what, source) => ({ text, what, source });
const paren = (n) => (n.text.startsWith("−") ? ["(", n, ")"] : [n]);
/** n1 + n2 + …, with negatives in parentheses. */
const plus = (nodes) => nodes.flatMap((n, i) => [...(i ? [" + "] : []), ...paren(n)]);

function build(ctx) {
  const { r, subject: s, model, tindex, asOf } = ctx;
  const S = Comps.SIM;
  const short = (c) => c.address;
  const modelSrc = `county model fitted on ${model.n_sales.toLocaleString()} Pasco market sales, ${model.window[0]} to ${model.window[1]}`;
  const subjSrc = "Pasco County Property Appraiser parcel record for this house";
  const asOfLeaf = data(asOf, "“as of” date", "the newest recorded sale in the data (prices are brought to this date)");
  const yearNow = new Date(asOf + "T00:00:00Z");
  const doy = Math.round((yearNow - Date.UTC(yearNow.getUTCFullYear(), 0, 1)) / DAY) + 1;

  function compNodes(c) {
    const name = short(c);
    const src = c.source === "redfin_upload" ? "your Redfin file (this browser only)" : "Pasco County Property Appraiser recorded sale";
    const compSrc = `${src}; features from the county's parcel record`;
    const price = data(money(c.price), `${name}: sale price`, `${src}, ${c.date}, ${c.sale_class} sale`);

    // time: ZIP index ratio (and the neighborhood trend if on)
    const series = tindex[c.zip] || [];
    let then = null;
    for (const p of series) { if (p[0] <= c.date.slice(0, 7)) then = p; else break; }
    const last = series[series.length - 1];
    const zipF = c.time_factor / c.local_factor;
    const zipFactor = then && last
      ? calc(x(zipF), `${name}: ZIP ${c.zip} home value change, ${monthName(then[0])} to ${monthName(last[0])}`, [
        data(money(last[1]), `Zillow home value index, ZIP ${c.zip}, ${monthName(last[0])}`, "Zillow Research ZHVI (middle tier, smoothed, seasonally adjusted); latest month"),
        " ÷ ",
        data(money(then[1]), `Zillow home value index, ZIP ${c.zip}, ${monthName(then[0])}`, "Zillow Research ZHVI; the month of the sale (or the last month before it)")])
      : data("1", `${name}: no index for this ZIP or month`, "no time adjustment");
    let todayParts = [price, " × ", zipFactor];
    if (c.local_factor !== 1) {
      const t = ctx.local[c.nbhd];
      const years = calc(x((Date.parse(asOf) - Date.parse(c.date)) / DAY / 365.25, 3), `${name}: years since the sale`,
        [calc(String(Math.round((Date.parse(asOf) - Date.parse(c.date)) / DAY)), "days since the sale", [asOfLeaf, " − ", data(c.date, "sale date", src)]), " ÷ 365.25"]);
      const localF = calc(x(c.local_factor), `${name}: neighborhood ${c.nbhd} trend vs its ZIP`, ["e^(", data(x(t.slope), `neighborhood ${c.nbhd} trend, log per year`,
        "slope of log(price ÷ just value) − log(ZIP index) over 24 months of sales, pulled toward 0 by how scattered they are (nbhd_trend.json)"), " × ", years, ")"]);
      todayParts = [price, " × ", zipFactor, " × ", localF];
    }
    const today = calc(money(c.time_adjusted), `${name}: sale price brought to today`, todayParts);

    // features
    const sv = (v, what) => data(String(v), `this house: ${what}`, subjSrc);
    const cv = (v, what) => data(String(v), `${name}: ${what}`, compSrc);
    const diffParts = (f) => {
      switch (f) {
        case "ln_sqft": return ["ln(", sv(num(s.sqft), "heated sq ft"), ") − ln(", cv(num(c.sqft), "heated sq ft"), ")"];
        case "ln_lot": return ["ln(", sv(s.lot_acres ?? 0.15, "lot acres"), ") − ln(", cv(c.lot_acres ?? 0.15, "lot acres"), ")"];
        case "age": {
          const subjAge = calc(x(yearNow.getUTCFullYear() + doy / 366 - s.year_built), "this house: age as of the “as of” date", [
            data(String(yearNow.getUTCFullYear()), "year of the “as of” date", asOf), " + ", data(`${doy}/366`, `day of the year (${asOf})`, "fraction of the year gone by"),
            " − ", sv(s.year_built, "year built")]);
          const saleYear = +c.date.slice(0, 4);
          const compAge = calc(String(saleYear - c.year_built), `${name}: age in the year it sold`, [
            data(String(saleYear), `${name}: year of the sale`, `${src}, ${c.date}`), " − ", cv(c.year_built, "year built")]);
          return [subjAge, " − ", compAge];
        }
        case "baths": return [sv(s.baths, "baths"), " − ", cv(c.baths, "baths")];
        case "pool": return [sv(s.pool ? 1 : 0, "pool (1 = yes)"), " − ", cv(c.pool ? 1 : 0, "pool (1 = yes)")];
        case "two_story": return [sv((s.stories ?? 1) >= 2 ? 1 : 0, "two-story (1 = yes)"), " − ", cv((c.stories ?? 1) >= 2 ? 1 : 0, "two-story (1 = yes)")];
        case "quality": return [sv(s.quality, "quality grade"), " − ", cv(c.quality, "quality grade")];
        case "new": {
          const subjAge = yearNow.getUTCFullYear() + doy / 366 - s.year_built, compAge = +c.date.slice(0, 4) - c.year_built;
          return [sv(subjAge <= 2 ? 1 : 0, `built within 2 years (1 = yes; age ${x(subjAge, 2)})`), " − ",
            cv(compAge <= 2 ? 1 : 0, `built within 2 years of its sale (1 = yes; age ${compAge})`)];
        }
        default: return [];
      }
    };
    const terms = c.adjustments.map((a) => {
      const coef = data(x(a.coef), `effect per unit of ${a.label}`, modelSrc);
      const diff = calc(x(a.difference), `${name}: ${a.label} difference, this house − comp`, diffParts(a.feature));
      const term = calc(x(a.coef * a.difference, 5), `${name}: ${a.label}, change in log price`, [coef, " × ", ...paren(diff)]);
      const change = calc(x(a.pct / 100, 5), `${name}: ${a.label}, price change (0.01 = 1%)`, ["e^", ...paren(term), " − 1"]);
      return { a, term, change };
    });
    const logSum = calc(x(sum(terms.map((t) => t.a.coef * t.a.difference)), 5), `${name}: total change in log price`,
      terms.length ? plus(terms.map((t) => t.term)) : ["no differences"]);
    const adjusted = calc(money(c.adjusted_price), `${name}: adjusted to this house`, [today, " × e^", ...paren(logSum)]);
    const gross = calc(x(c.gross_pct / 100), `${name}: gross adjustment, price changes with signs dropped`,
      terms.length ? terms.flatMap((t, i) => [...(i ? [" + "] : []), "|", t.change, "|"]) : ["none"]);

    // similarity
    const w = (k) => data(String(S[k]), `similarity weight for ${k === "dist" ? "distance" : k === "months" ? "how long ago" : k}`, "set by hand; tuning didn't find better values");
    const subjLot = s.lot_acres ?? 0.15, subjBaths = s.baths ?? 2;
    const days = calc(String(Math.round((Date.parse(asOf) - Date.parse(c.date)) / DAY)), `${name}: days since the sale`, [asOfLeaf, " − ", data(c.date, `${name}: sale date`, src)]);
    const part = (k, label, inner) => calc(x(S[k] * c.sim_parts[k], 3), `${name}: ${label} penalty`, [w(k), " × ", ...inner]);
    const parts = [
      part("size", "size", ["|ln(", cv(num(c.sqft), "heated sq ft"), " ÷ ", sv(num(s.sqft), "heated sq ft"), ")| ÷ 0.15"]),
      part("age", "age", ["|", cv(c.year_built ?? s.year_built, "year built"), " − ", sv(s.year_built, "year built"), "| ÷ 10"]),
      part("lot", "lot", ["|ln(", cv(c.lot_acres ?? subjLot, "lot acres"), " ÷ ", sv(subjLot, "lot acres"), ")| ÷ 0.5"]),
      part("baths", "baths", ["|", cv(c.baths ?? subjBaths, "baths"), " − ", sv(subjBaths, "baths"), "|"]),
      part("pool", "pool", [Boolean(c.pool) === Boolean(s.pool) ? "0 (both the same)" : "0.5 (one has a pool)"]),
      part("dist", "distance", [data(x(c.distance_mi, 3), `${name}: miles from this house`, "straight line between the two parcels' centers on the county parcel map")]),
      part("months", "how long ago", [days, " ÷ 30.4 ÷ 6"]),
    ];
    const bonuses = [];
    if (c.nbhd === s.nbhd) bonuses.push(data(String(S.same_nbhd), `bonus: same appraiser neighborhood (${s.nbhd_name || s.nbhd})`, "set by hand"));
    if (c.subdivision === s.subdivision) bonuses.push(data(String(S.same_subdivision), `bonus: same subdivision (${s.subdivision})`, "set by hand"));
    const penaltyV = sum(["size", "age", "lot", "baths", "pool", "dist", "months"].map((k) => S[k] * c.sim_parts[k])) - sum(bonuses.map((b) => +b.text));
    const penalty = calc(x(penaltyV), `${name}: similarity penalty`, [...plus(parts), ...bonuses.flatMap((b) => [" − ", b])]);
    const sim = calc(x(c.similarity), `${name}: similarity`, ["1 ÷ (1 + ", penaltyV < 0 ? "0" : penalty, ")"]);
    const distressed = c.sale_class === "distressed" ? [" × ", data(String(Comps.DISTRESSED_WEIGHT), "distressed sale weight", "bank, short and other distressed sales count half")] : [];
    const weight = calc(x(c.weight), `${name}: weight`, [sim, " ÷ (1 + ", gross, ")", ...distressed]);
    return { c, today, adjusted, sim, weight, distressed, name };
  }

  const nodes = r.comps.map(compNodes);
  const m = r.methods;

  // adjusted comps value
  const W = sum(r.comps.map((c) => c.weight)), WP = sum(r.comps.map((c) => c.weight * c.adjusted_price));
  const prods = nodes.map((n) => calc(money(n.c.weight * n.c.adjusted_price), `${n.name}: weight × adjusted price`, [n.weight, " × ", n.adjusted]));
  const compsValue = calc(money(m.comps.fair_value), "adjusted comps value: the comps' adjusted prices, weighted", [
    calc(money(WP), "sum of weight × adjusted price", plus(prods)), " ÷ ", calc(x(W), "sum of the weights", plus(nodes.map((n) => n.weight)))]);

  // just-value ratio
  let assessedValue = null;
  if (m.assessed.fair_value != null) {
    const used = new Set(m.assessed.used), kept = nodes.filter((n) => used.has(n.c.parcel_id));
    const dropped = nodes.length - kept.length;
    const aw = (n) => (n.distressed.length ? calc(x(n.c.similarity * Comps.DISTRESSED_WEIGHT), `${n.name}: weight`, [n.sim, ...n.distressed]) : n.sim);
    const ratio = (n) => calc(x(n.c.time_adjusted / n.c.just_value), `${n.name}: today's price ÷ its just value`, [n.today, " ÷ ",
      data(money(n.c.just_value), `${n.name}: just value`, "Pasco County Property Appraiser: the county's market estimate as of Jan 1, not the capped value on the tax bill")]);
    const WR = sum(kept.map((n) => (n.c.similarity * (n.distressed.length ? Comps.DISTRESSED_WEIGHT : 1)) * n.c.time_adjusted / n.c.just_value));
    const AW = sum(kept.map((n) => n.c.similarity * (n.distressed.length ? Comps.DISTRESSED_WEIGHT : 1)));
    const wr = kept.map((n) => calc(x(n.c.similarity * (n.distressed.length ? Comps.DISTRESSED_WEIGHT : 1) * n.c.time_adjusted / n.c.just_value), `${n.name}: weight × ratio`, [aw(n), " × ", ratio(n)]));
    const ratioNode = calc(x(m.assessed.ratio, 6), `the comps' price ÷ just value, weighted by similarity${dropped ? ` (${dropped} dropped: more than 1.5× from the median)` : ""}`, [
      calc(x(WR), "sum of weight × ratio", plus(wr)), " ÷ ", calc(x(AW), "sum of the weights", plus(kept.map(aw)))]);
    assessedValue = calc(money(m.assessed.fair_value), "just-value ratio value", [
      data(money(s.just_value), "this house: just value", "Pasco County Property Appraiser: the county's market estimate as of Jan 1, not the capped value on the tax bill"), " × ", ratioNode]);
  }

  const name = METHOD_NAMES[ctx.method];
  if (ctx.method === "blend") return calc(money(m.blend.fair_value), `fair value (${name})`, ["(", compsValue, " + ", assessedValue, ") ÷ 2"]);
  if (ctx.method === "assessed") return calc(assessedValue.text, `fair value (${name})`, assessedValue.parts);
  return calc(compsValue.text, `fair value (${name})`, compsValue.parts);
}

// ---------- drawing: a number you can open is a link; opening it shows its equation underneath ----------
function line(node) {
  const box = document.createElement("div");
  box.className = "drill";
  const head = document.createElement("div");
  head.className = "dline";
  head.innerHTML = `<div class="what">${esc(node.what)}</div>`;
  const eq = document.createElement("div");
  eq.className = "eq";
  const kids = document.createElement("div");
  kids.className = "kids";
  if (node.source) {
    eq.innerHTML = `<b>${esc(node.text)}</b> <span class="src">from ${esc(node.source)}</span>`;
  } else {
    for (const p of node.parts) eq.append(typeof p === "string" ? p : token(p, kids));
    eq.append(" = ");
    const b = document.createElement("b"); b.textContent = node.text; eq.append(b);
  }
  head.append(eq);
  box.append(head, kids);
  return box;
}

function token(node, kids) {
  const t = document.createElement("button");
  t.type = "button";
  t.className = node.source ? "num leaf" : "num";
  t.textContent = node.text;
  t.title = node.what;
  t.setAttribute("aria-expanded", "false");
  let open = null;
  t.onclick = () => {
    if (open) { open.remove(); open = null; t.setAttribute("aria-expanded", "false"); return; }
    open = line(node);
    kids.append(open);
    t.setAttribute("aria-expanded", "true");
  };
  return t;
}

// ---------- page ----------
const settings = County.decodeSettings(location.hash);

async function main() {
  const back = "value.html" + (settings.a ? County.encodeSettings({ ...settings, focus: null }) : "");
  $("#back").href = back; $("#nav-value").href = back;
  $("#to-math").href = "math.html" + County.encodeSettings({ ...settings, focus: null });
  if (!settings.a) { $("#status").innerHTML = `Pick a home on the <a href="value.html">value page</a> first.`; return; }
  const ctx = await County.valueFromLink(settings);
  if (ctx.error) { $("#status").textContent = ctx.error; return; }
  if (!ctx.r.comps.length || ctx.r.fair_value == null) { $("#status").textContent = "No qualifying sales were found for this home."; return; }
  $("#status").textContent = "";
  $("#title").textContent = ctx.subject.address;
  document.title = `Drill Down · ${ctx.subject.address}`;
  $("#out").replaceChildren(line(build(ctx)));
  const series = ctx.tindex[ctx.subject.zip] || [];
  $("#sources").textContent = `Sources: Pasco County Property Appraiser parcels and recorded sales through ${ctx.meta.latest_sale}` +
    (ctx.added.length ? `, plus ${ctx.added.length} sales from your Redfin file (this browser only)` : "") +
    `; Zillow home value index by ZIP through ${series.length ? monthName(series[series.length - 1][0]) : "—"}. Dollar amounts are rounded; the math uses full precision.`;
}

main().catch((e) => { $("#status").textContent = "Something went wrong: " + e.message; });
