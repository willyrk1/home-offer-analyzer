// Node runner for site/comps.js against exported county files (used by tests).
// usage: node tests/run_comps.js <site/data dir> <county> "<address>"
const fs = require("fs"), path = require("path");
const Comps = require(path.join(__dirname, "..", "site", "comps.js"));
const [dir, county, address] = process.argv.slice(2);
const base = path.join(dir, "counties", county);
const read = (f) => JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
const meta = read("meta.json"), model = read("model.json"), tindex = read("tindex.json");
const streets = read("streets.json"), neighbors = read("neighbors.json");
const parsed = Comps.parseAddress(address), key = parsed.key;
const zips = Comps.candidateZips(parsed, streets).filter((z) => fs.existsSync(path.join(base, `parcels/${z}.json`)));
let subject = null;
for (const z of zips) {
  subject = Comps.fromTable(read(`parcels/${z}.json`)).find((p) => p.address_key === key);
  if (subject) break;
}
if (!subject) { console.log(JSON.stringify({ error: "not found", key, zips })); process.exit(0); }
const sales = (neighbors[subject.zip] || [subject.zip]).flatMap((z) =>
  fs.existsSync(path.join(base, `sales/${z}.json`)) ? Comps.fromTable(read(`sales/${z}.json`)) : []);
const trendFile = path.join(base, "nbhd_trend.json");
const local = process.env.ZIP_ONLY || !fs.existsSync(trendFile) ? null : JSON.parse(fs.readFileSync(trendFile, "utf8")).nbhds;
const r = Comps.valueSubject(subject, sales, model, tindex, { asOf: meta.latest_sale, local });
const extra = process.argv[5] ? Comps.explain(Comps.normalizeAddress(process.argv[5]), subject, sales, model, tindex, r, { local }) : null;
console.log(JSON.stringify({ fair_value: r.fair_value, range: r.range, search: r.search, as_of: r.as_of,
  methods: Object.fromEntries(Object.entries(r.methods).map(([k, v]) => [k, { fair_value: v.fair_value, range: v.range }])),
  comps: r.comps.map((c) => ({ parcel_id: c.parcel_id, adjusted_price: c.adjusted_price, weight: c.weight, local_factor: c.local_factor })),
  explain: extra && { verdict: extra.verdict, reasons: extra.reasons,
    what_if: extra.whatIf ? extra.whatIf.fair_value : null },
  full: process.env.FULL ? { subject, as_of: r.as_of, search: r.search, pool_size: r.pool_size, methods: r.methods,
    comps: r.comps.map(({ address, date, price, sale_class, zip, nbhd, subdivision, sqft, year_built, baths, lot_acres, pool, stories, quality,
      distance_mi, similarity, sim_parts, time_factor, time_note, time_adjusted, adjustments, adjusted_price, net_pct, gross_pct, weight, just_value }) =>
      ({ address, date, price, sale_class, zip, nbhd, subdivision, sqft, year_built, baths, lot_acres, pool, stories, quality, distance_mi, similarity,
        sim_parts, time_factor, time_note, time_adjusted, adjustments, adjusted_price, net_pct, gross_pct, weight, just_value })) } : undefined }));
