# Home Offer Analyzer

A free, static web site that values listed homes from closed-sale comps and suggests offer prices, with every step visible. This repo is at **step 1 of the build plan: market-only mode**.

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

1. ~~Market-only mode~~ ← this repo
2. First county sales adapter (Pasco Property Appraiser), sale classification, Redfin recent-sales upload
3. County regression, comp selection, "show the math"
4. Leverage table and offer recommendation
5. Own forecast model, backtests, forecast blend
6. User-suggested comps, competition check, builder floor, concessions converter

Data: Zillow Research and the Redfin Data Center. Check each provider's terms for attribution. Not an appraisal or financial advice.
