"""Public data sources and how to download them.

All URLs are free, public files. If a provider renames a file, update it here.
"""
from __future__ import annotations

import gzip
import shutil
import urllib.request
from pathlib import Path

ZILLOW_BASE = "https://files.zillowstatic.com/research/public_csvs"

SOURCES = {
    # Zillow Home Value Index, ZIP level, all homes (SFR + condo), middle tier,
    # smoothed and seasonally adjusted, monthly.
    "zillow_zhvi": f"{ZILLOW_BASE}/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    # Zillow Home Value Forecast, ZIP level: 1-month, 3-month and 12-month growth.
    "zillow_forecast": f"{ZILLOW_BASE}/zhvf_growth/Zip_zhvf_growth_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    # Redfin Data Center market tracker, ZIP level, rolling 90-day windows.
    # Large (hundreds of MB compressed); it is streamed and filtered in chunks.
    "redfin_zip": "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/zip_code_market_tracker.tsv000.gz",
}

USER_AGENT = "home-offer-analyzer/0.1 (+https://github.com/willyrk1/home-offer-analyzer)"


def download(name: str, dest_dir: Path) -> Path:
    """Download one source into dest_dir and return the local path."""
    url = SOURCES[name]
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(url).name
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=600) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out, length=1 << 20)
    return dest


def open_text(path: Path):
    """Open a .csv/.tsv, gzipped or not, as text."""
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return open(path, "r", encoding="utf-8", newline="")
