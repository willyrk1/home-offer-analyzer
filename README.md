# Home Offer Analyzer

A free, static web site that values listed homes from closed-sale comps and suggests offer prices, with every step visible. Steps 1–3 of the build plan are done: market trends for covered ZIPs, and comps-based valuation for Pasco County.

## What works now

- **Weekly build** (GitHub Actions) downloads three free public files:
  - Zillow Research home value index by ZIP (monthly)
  - Zillow Research 12-month home value forecast by ZIP
  - Redfin Data Center ZIP market tracker (rolling 90-day windows)
- **ZIP indicators** for every ZIP in a covered county:
  - Typical value; 1-year, 3-month and since-2019 change
  - Share of listings with price cuts, vs the same month last year
  - Inventory vs last year and vs 2019
  - Median days on market and sale-to-list ratio vs last year
  - Zillow's 12-month forecast
- **A plain-language read** ("buyer leverage rising" / "mixed" / "seller leverage rising") from the leading indicators, with the scoring shown.
- **Forecast archive:** each new Zillow forecast is saved to `data/archive/` so it can be backtested later. This archive can't be recreated, so it starts on the first run.
- **The site** (`site/`): ZIP search, sortable table of all covered ZIPs, indicator tiles and trend charts. No external libraries.

## Value a home (Pasco County)

`site/value.html` values any Pasco residential parcel from recent closed sales:

- **Data:** the Pasco Property Appraiser's weekly bulk files (parcels, buildings, pools, addresses, recorded sales) and the county parcel map for locations. Owner files are never downloaded.
- **Sale classification:** the appraiser's qualified flag and state codes. Market sales count fully; bank-owned, foreclosure-deed, short and bankruptcy sales count at half weight; family, related-party, multi-parcel and other non-market transfers are excluded (with the reason shown).
- **County model:** a regression on the last two years of market sales gives the value of size, age, lot, baths, pool, stories and quality grade (`pipeline/valuation.py`).
- **Comps:** nearest similar sales, widening the radius and then the time window until there are at least 6; each is time-adjusted with the ZIP home value index and feature-adjusted with the county model, then weighted by similarity and adjustment size (`pipeline/comps.py`, mirrored in `site/comps.js`; a test keeps the two identical).
- **On the page:** show-the-math for each comp, remove a comp, include or exclude distressed sales, and "why wasn't this sale used?" with a what-if and an option to add it anyway.

`python -m pipeline.comps_report "<address>"` prints the same analysis as text, and the **Comps report** workflow runs it on the real data.

## Coverage

Edit `coverage.yaml` to add or remove counties, or to add single ZIPs under `extra_zips`. Every county starts at `level: market`; comps and offers need a county sales-record adapter (step 2).

## Run locally

```bash
pip install -r requirements.txt
python -m pytest -q

# Full build with real downloads (Redfin's file is several hundred MB):
python -m pipeline.build

# Or preview with small synthetic sample files:
python -m tests.fixtures raw-sample
python -m pipeline.build --raw-dir raw-sample --offline

# Serve the site
python -m http.server -d site 8000   # then open http://localhost:8000
```

## One-time GitHub setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Actions → Weekly data build → Run workflow** for the first build. After that it runs every Monday.
3. Scheduled workflows in public repos pause after 60 days without repo activity. The weekly archive commit should keep it active, but check occasionally.

## Layout

```
coverage.yaml            covered counties and ZIPs
pipeline/sources.py      download URLs
pipeline/load.py         parse Zillow/Redfin files, filter to covered ZIPs
pipeline/indicators.py   ZIP indicators and the buyer-leverage read
pipeline/build.py        orchestrates a run; writes site/data/*.json
data/archive/            saved Zillow forecasts (committed)
site/                    static site served by GitHub Pages
tests/                   synthetic fixtures in the providers' real formats, and tests
```

## Next steps (from the spec)

1. ~~Market-only mode~~
2. ~~Pasco sales adapter and sale classification~~ (Redfin recent-sales upload still to do)
3. ~~County regression, comp selection, "show the math", "why not this comp"~~
4. Leverage table and offer recommendation; backtest across many sales
5. Own forecast model, backtests, forecast blend
6. User-suggested comps, competition check, builder floor, concessions converter

Data: Zillow Research and the Redfin Data Center. Check each provider's terms for attribution. Not an appraisal or financial advice.
