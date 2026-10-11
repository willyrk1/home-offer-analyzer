# CLAUDE.md — Home Offer Analyzer

Context for Claude Code sessions. Read this, then README.md. The product spec is a
Claude Doc ("Home Offer Analyzer — Project Spec") that Bill can share; its build
order is mirrored at the bottom of this file.

## What this is

A free static site (GitHub Pages) that values listed homes from closed-sale comps
and suggests offers, showing every step. Built as a transparent alternative to the
Reventure app, whose numbers we found hard to trust (see "Lessons from Reventure").

- Live: https://willyrk1.github.io/home-offer-analyzer/ (`index.html` market trends,
  `value.html` value a home)
- Owner: Bill (Wesley Chapel, FL). Comfortable with code; prefers plain explanations,
  wants the math shown, and pushes back on assumptions — expect "why?" questions.

## Architecture

```
weekly GitHub Action (.github/workflows/weekly.yml, Mondays)
  pipeline/build.py         Zillow ZHVI + forecast, Redfin ZIP tracker, Realtor.com ZIP
                            listings -> site/data/index.json, zips/<zip>.json, diagnostics.json
  pipeline/county_build.py  Pasco appraiser files -> parcels/sales -> county regression
                            -> site/data/counties/pasco/* (via pipeline/site_export.py)
  deploy site/ to Pages
browser
  site/app.js               market pages
  site/comps.js + value.js  comps engine runs client-side on the exported county files
```

No server. `site/data/` is generated (gitignored); `data/archive/` (Zillow forecast
snapshots for future backtests) is committed by the workflow and can't be recreated.

## Commands

```bash
pip install -r requirements.txt          # geopandas/pyogrio needed for the parcel map
python -m pytest -q                      # 33 tests; JS parity tests need node
python -m pipeline.build                 # market data (downloads ~few hundred MB)
python -m pipeline.county_build          # Pasco (downloads ~800 MB incl. 684 MB map; ~10 min)
python -m pipeline.county_build --offline --raw-dir raw/pasco   # reuse downloads
python -m pipeline.comps_report "1295 Montgomery Bell Rd, Wesley Chapel, FL 33543"
node tests/run_comps.js site/data pasco "<address>"            # browser engine, same data
python -m pipeline.backtest [--sample 500]   # value last 12 months of sales as of the day before each
python -m http.server -d site 8000       # preview
# sample data, no downloads:
python -m tests.fixtures raw-sample && python -m pipeline.build --raw-dir raw-sample --offline
```

Earlier sessions ran in a sandbox that couldn't reach Zillow/Redfin/Pasco, so real-data
checks went through the `comps-report` and `probe-pasco` workflows, which write results
to the `probe-output` branch. Locally you can just run things; those workflows remain
useful for checking the CI environment.

## Invariants — don't break these

1. **Python and JS comps engines must agree exactly.** `pipeline/comps.py` +
   `pipeline/valuation.design` and `site/comps.js` are mirrors; `tests/test_comps_js.py`
   requires identical comp lists and values to 1e-9. Change both together.
   Subtleties already matched: pandas `DateOffset(months=n)` month-end clamping
   (`addMonths`), `dayofyear/366` for subject age, NaN-baths default = median of the
   frame, `days/30.4/6` recency.
2. **"As of" date = latest market/distressed sale date**, in both engines and in
   `site_export` (`meta.latest_sale`). Not today's date.
3. **Privacy:** never download `owners.zip`; no owner names or mailing addresses in
   any output or the public repo. The repo and site are public. **MLS data must never
   be committed or published** (license).
4. **Every number on the site names its source and month.** Users compare against
   Zillow/Redfin/Reventure and need to know what they're looking at.
5. **Each signal counted once:** comps' time adjustment covers past -> today; any
   forecast covers today -> +12 months only. Don't double-count market decline.
6. **Year-over-year comparisons use the same month a year earlier** (seasonality —
   price cuts always rise in autumn).
7. Optional sources (Realtor.com) must not break the build; record failures in
   `diagnostics.json`. County build failure must not block market pages
   (`continue-on-error` in weekly.yml).

## Data sources and their quirks (learned the hard way)

**Zillow Research** (`pipeline/sources.py`): ZHVI by ZIP (`Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`)
and the ZIP forecast (`zhvf_growth`, last 3 date columns = 1m/3m/12m horizons, `BaseDate`).
Zillow 12-mo forecasts are mildly positive (33543: +0.2%, 37323: +0.7% as of Aug 2026).
Reventure's "Home Value Growth YoY" matches ZHVI exactly — they use ZHVI too.

**Redfin ZIP tracker** (`zip_code_market_tracker.tsv000.gz`, ~10M rows, streamed in chunks):
- `PRICE_DROPS` and `MONTHS_OF_SUPPLY` are **empty at ZIP level** (we derive months of
  supply = inventory / (homes_sold/3)).
- Latest window **stopped at May 2026** (checked Oct 2026). Keep only `PERIOD_DURATION==90`.

**Realtor.com Research** (`RDC_Inventory_Core_Metrics_Zip_History.csv` on econdata S3):
monthly through Sep 2026; supplies price-cut share, active listings, listing DOM.
`indicators.combine()` picks the newer source per indicator. Its price-cut share runs
45–55% — likely counts any reduction in the month; trust year-over-year change more
than the level. File ends with a footnote row (filtered).

**Pasco Property Appraiser** (`https://downloads.pascopa.com/` -> `ftp01.pascopa.com`,
weekly, free). Probe report with full layouts and code tables: `probe-output` branch,
`pasco-probe-report.txt`. Key facts:
- `sales.zip/sales_last_10years.csv`: `Sale_Qualified` Q/U and DOR codes in
  `Sale_Qalified_Code` (**sic**, misspelled column). Codes appear as "01" and "1".
  Classification (`pasco.classify_sales`): Q = market; U with codes 12 (bank),
  19 (bankruptcy), 38 (short sale) or deeds CT/SD/TX/FJ/RD/MD = distressed (half weight);
  everything else excluded with a plain-language `reason`. Multi-parcel deeds
  (same book/page+date, or code 05) excluded. Price < $10K excluded.
- `building.csv`: heated sq ft, actual/effective year, baths, stories, quality (1–5),
  use code (0100 SFR, 0700 townhome, 0400 condo). **No bedroom count.**
- `extrafeatures.csv`: pools = codes starting `RPOOL`, spa = `RSPA`.
- `parcel.csv`: acres, just value, `NBHD_Code` (appraiser neighborhood; Union Park = UNPK).
- `site_addresses.csv`: street names spelled out (ROAD, LANE); `normalize_address`
  maps listing abbreviations. Subdivision key = first 4 parts of parcel number.
- `pasco_parcels.zip` (684 MB): shapefile is at `workspace/scripts/pascoshp/pasco_parcels.shp`
  inside the zip (not root); `_gis_source` searches. Read only the parcel-ID column with
  pyogrio; CRS defaults to EPSG:2882. 99.9% of parcels located.
- Metadata page (`downloads.pascopa.com/metadata/`) returns 403; use the probe report.

## Model status (real Pasco data, Sep 2026)

- County regression: 20,734 market sales (2 yrs), R² 0.81, median abs error 10.2%
  before comps. Coefficients: ln sqft +0.61, age −0.0082/yr, ln lot +0.118,
  bath +0.053, pool +0.135, two-story −0.044, quality +0.113/step, new +0.001.
- Blind checks (subject's own sale excluded): 32237 Watoga Loop $469K vs sold $485K
  (−3%); 32373 Bannack Ln $524K vs $500K (+5%). Only two points — **needs a real backtest.**
- 1295 Montgomery Bell Rd (listed $485K, cut from $499,999 on Aug 7 listing):
  fair value $449K ($427K–$472K). Redfin estimate ~$478K. Key comp Redfin missed:
  32101 Goddard Dr (near-twin, $450K Apr 2026, 0.11 mi).
- **Backtest** (`pipeline/backtest.py`, Oct 2025–Sep 2026, 10,376 sales, no look-ahead):
  median abs error 9.4%, bias −0.7%, 52% within 10%, 60% inside the shown range.
  $350K–600K 6.6–7.1%; townhomes 5.9%; new builds 4.8%; Wesley Chapel/Land O' Lakes ZIPs 5–7%.
  Weak: under $250K 17% (bias +8.5%), $800K+ bias −7.9% (regression to the middle),
  condos 14.5%, west Pasco (34652, 34690) 19–20%, comps from 3–5 mi 16–25%.
- **Tuning** (`pipeline/tune.py`, Oct 2026): coordinate descent over SIM weights, comp
  counts, distressed weight, radius. Search months 9.61% -> 9.27%, but held-back months
  9.39% -> 9.37%: noise. Defaults kept. Comp selection is not the bottleneck; missing
  condition data is.
- **Valuation methods** (`comps.METHODS`, both engines): `comps`, `assessed` (subject just
  value x comps' weighted time-adjusted price / just value; no feature adjustments; n/a when
  the subject's just value looks partial, e.g. finished after Jan 1) and `blend` (average).
  Compared on 2026 sales only (just values are as of Jan 1 from earlier sales), same 7,658
  sales: comps 9.33%, assessed 9.03%, blend 8.76%. Blend wins every month, but its edge
  shrinks from ~0.7 pts (Feb–Apr) to ~0.3 (Jul–Sep): stale Jan 1 values or slight leakage.
  backtest.json `methods.best` sets the page default; all methods stay selectable (Bill:
  offer every viable option, default to the best). Just value ≈ 85% of market (median
  sale/JV 1.15).
- **No price-level bias.** The "cheap homes valued 8% high, $800K+ 8% low" pattern was an
  artifact of grouping by *sale price* (sorting on the outcome). Grouped by *our value*,
  lean is within ±1.5% in every band; a fitted correction made held-back months worse
  (9.18% -> 9.68%). Rejected. Reports now band by our value.
- **Ranges are calibrated** (`backtest.calibrate`, `comps.calibrated_range`, both engines):
  fair x exp(±h), h = sqrt((a x ZIP's median abs log miss)² + (k x comps' relative spread)²),
  fitted per method for 50/80/90% on odd months, checked on even: held 51/80/90% (blend).
  Adapts locally: 80% half-width ~±14% in 33543, ~±50% in 34652. Page default 80%,
  buttons for 50/90. The old ±1-spread range (held 60%) is gone.
- **Market signals don't predict sale vs our value** (`pipeline/leverage.py`, run by the
  backtest into backtest.json `market_signals`): Realtor.com ZIP YoY price-cut share, active
  listings, listing DOM, list price (month before sale) correlate < 0.02 with log(sale/value);
  fitted on odd months they made even months worse (8.88% -> 9.19%). So no leverage
  adjustment: comps + ZHVI already carry it. The page shows the signals as context only.
- **Offer** (`site/offer.js`): opening / target / walk-away = low end / fair value / high end
  of the calibrated 50% range (≈ 25th/50th/75th percentile of where similar homes sold),
  none above list; listed-below-range = expect competition. Appraisal check = cash gap above
  fair value. Concessions converter: credit to closing costs vs rate buydown (points at an
  editable rate cut per point) vs price cut, with buydown's price-cut equivalent. Optional
  days on market vs Realtor.com ZIP listing DOM is a qualitative note only (not measurable
  from county data).
- **Builder floor** (`Offer.builderFloor`, per the spec): only for new construction (built
  this year or last, as of the latest sale) or when the user marks a home builder-owned;
  checkbox off by default, and nothing about the floor shows when off. floor = (lot +
  build $/sf × heated sf [+ carrying $/mo × months unsold]) × (1 + min margin, default 15%).
  Lot and build cost are user-entered; no data source, so placeholders are labeled "e.g."
  and never used as values. A reference line only: never changes comps, fair value or
  offer prices. Says plainly when fair value < floor (deal hinges on concessions) or list
  is within 3% of it. Context from recorded sales (`pipeline/builder.py`, both engines):
  lowest builder $/sf in the subdivision over 6 months (≥3 closings) × subject sf; 85% of
  1,057 Pasco builder closings came in at or above that level set by earlier ones (resales
  vs the same kind of level: 82%), so it's soft. Spec example (220 Hollow Rd, Cleveland TN):
  $60K + 2,314 sf × $140 = $384K × 1.15 = $442K.
- **Redfin "recently sold" CSV** (`site/upload.js`, value page): fills the weeks before
  closings reach county records. MLS data, so it never leaves the viewer's browser (kept in
  localStorage, removable; a test checks upload.js makes no network calls; `*redfin*.csv`
  is gitignored). Rows match a parcel by normalized address + ZIP and use the *county's*
  features; skipped with a reason if not a sale, no parcel, several units at one address,
  or already recorded (same parcel within 45 days). Added sales count as market sales and
  move "as of" to the newest one (invariant 2). Redfin's "local MLS rules" footnote row is
  ignored. JS only: the Python report doesn't read uploads.
- Known gaps: condition/upgrades/views (e.g. conservation lots) not in the data;
  two-story discount may partly proxy for floor-plan/age effects; weights in
  `_similarity` are hand-set, not tuned.

## Lessons from Reventure (why the design is what it is)

Bill's wife pays for Reventure; we reverse-engineered its listing analyzer from
screenshots (220 Hollow Rd, Cleveland TN 37323):
- Fair value = median $/sf of "similar homes" × sq ft — those comps were **active and
  stale listings, including the subject itself**, not closed sales.
- Then it **subtracts its full 1-yr ZIP forecast** (−7.89%) from today's value,
  then a "desperation" discount (score/100 × 10%), then ×0.95/1.00/1.03 for offer tiers.
- Its ZIP "overvalued %" tracks 5-yr growth (trend deviation) plus price-to-income;
  FAU's Beracha–Johnson ranking (log-linear trend on ZHVI since 1996) broadly agrees
  at metro level (Jan 2025: Knoxville ~20%, Chattanooga ~15%, Tampa ~11.6%).
We do the opposite on each point: closed sales, subject excluded, forecast applied
only as a confidence-weighted, user-toggleable adjustment, measured (not formula)
leverage.

## Next steps (spec build order)

1. ~~Market-only mode~~
2. ~~Pasco sales adapter + sale classification~~, ~~Redfin "recently sold" CSV upload~~
3. ~~County regression, comps, show-the-math, why-not-this-comp~~
4. ~~Backtest + offer recommendation~~ — backtest, tuning (no gain), assessed/blend
   methods, calibrated ranges, measured (null) market leverage, offer + appraisal check +
   concessions converter. Redfin "recently sold" upload done (step 2).
5. Own ZIP forecast model (leading indicators, trained 2012–present incl. 2022–23),
   backtest vs Zillow using `data/archive/`, accuracy-weighted blend, show as a range.
   Also: FAU-style "above long-term trend %" per ZIP (Bill asked; show trend start date).
6. Competition check (active comparable listings), user-suggested comps polish,
   Tennessee counties (Knox, Bradley) — each needs a new adapter in
   `pipeline/counties/` implementing `FILES`, `download`, `build_parcels`,
   `load_sales`, `build_sales(keep_excluded=)`, `normalize_address`.
   Probe the county's files first (copy `probe_pasco.py`).

## Conventions

- Commits as Bill (`wknight94@gmail.com`); end messages with the attribution lines
  your session provides.
- Tests use synthetic files in the providers' **real layouts** (`tests/fixtures.py`,
  `tests/pasco_fixtures.py`); the Pasco fixture prices follow a known formula so tests
  check the regression recovers it. Add a fixture case whenever a real-data quirk is found.
- Site: no external JS/CSS libraries; light + dark via `prefers-color-scheme`;
  must work at 390px width (comps table becomes cards under 700px).
- Not an appraisal or financial advice — keep that line on every page.
