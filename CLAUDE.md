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
2. ~~Pasco sales adapter + sale classification~~ — Redfin "recently sold" CSV upload
   (fills the weeks before sales hit county records) still to do
3. ~~County regression, comps, show-the-math, why-not-this-comp~~
4. **Backtest + offer recommendation** ← start here
   - Backtest: for each market sale in the last 12 months, value it as of the day
     before its sale with its own sale excluded; report median abs % error, bias,
     % within 5/10%, by ZIP/price band/property type. Use it to tune `_similarity`
     weights, search radii, MIN/MAX comps. Keep Python/JS parity.
   - Leverage table: sale-to-final-list by days-on-market bucket needs list prices,
     which county data lacks — options: Realtor.com/Redfin aggregates by ZIP, or
     user-entered list/DOM per listing. Discuss with Bill.
   - Offer output: fair value, opening/target/walk-away, appraisal check, concessions
     converter (rate buydown/closing costs in dollars). Builder-floor toggle for new builds.
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
