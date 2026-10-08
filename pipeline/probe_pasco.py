"""One-off probe of the Pasco Property Appraiser bulk files.

Downloads the files the comps adapter will need and prints their layout:
columns, row counts, a few sample rows and the most common values of short
code-like columns. Owner names and mailing addresses are never downloaded
(owners.zip is skipped) and any column that looks like a name is masked.

    python -m pipeline.probe_pasco
"""
from __future__ import annotations

import io
import re
import urllib.request
import zipfile

import pandas as pd

BASE = "https://ftp01.pascopa.com/real_estate/"
FILES = ["sales.zip", "building.zip", "extrafeatures.zip", "parcel.zip",
         "land.zip", "site_addresses.zip", "subarea.zip", "subdivision_index.zip"]
EXTRA_URLS = ["https://downloads.pascopa.com/metadata/",
              "https://ftp01.pascopa.com/misc/Code_Descriptions.xlsx"]
UA = {"User-Agent": "home-offer-analyzer/0.1 (+https://github.com/willyrk1/home-offer-analyzer)"}
NAMEISH = re.compile(r"(own|name|grantor|grantee|buyer|seller|mail|addr_?1|addr_?2)", re.I)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        return r.read()


def describe(name: str, df: pd.DataFrame) -> None:
    masked = [c for c in df.columns if NAMEISH.search(c) and "site" not in c.lower()]
    show = df.drop(columns=masked)
    print(f"rows: {len(df):,}   columns: {len(df.columns)}")
    print("columns:", list(df.columns))
    if masked:
        print("masked (name/mailing-like):", masked)
    with pd.option_context("display.max_columns", None, "display.width", 250):
        print(show.head(3).to_string())
    for c in show.columns:
        s = show[c].dropna().astype(str)
        if s.empty:
            continue
        nunique = s.nunique()
        if nunique <= 60 and s.str.len().max() <= 40:
            top = s.value_counts().head(25)
            print(f"  {c}: {nunique} values -> " + ", ".join(f"{k}={v}" for k, v in top.items()))


def main() -> None:
    for f in FILES:
        print(f"\n===== {f} =====")
        try:
            data = fetch(BASE + f)
        except Exception as exc:  # noqa: BLE001
            print("download failed:", exc)
            continue
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            print("members:", [(i.filename, i.file_size) for i in z.infolist()])
            for member in z.namelist():
                if member.lower().endswith((".csv", ".txt")):
                    with z.open(member) as fh:
                        raw = fh.read()
                    sep = "|" if raw[:2000].count(b"|") > raw[:2000].count(b",") else ","
                    df = pd.read_csv(io.BytesIO(raw), sep=sep, dtype=str, low_memory=False,
                                     encoding="latin-1")
                    print(f"--- {member} (sep {sep!r})")
                    describe(member, df)

    for url in EXTRA_URLS:
        print(f"\n===== {url} =====")
        try:
            data = fetch(url)
        except Exception as exc:  # noqa: BLE001
            print("download failed:", exc)
            continue
        if url.endswith(".xlsx"):
            sheets = pd.read_excel(io.BytesIO(data), sheet_name=None, dtype=str)
            for sheet, df in sheets.items():
                print(f"--- sheet {sheet}: {len(df)} rows; columns {list(df.columns)}")
                with pd.option_context("display.max_rows", 400, "display.width", 250):
                    print(df.head(400).to_string())
        else:
            text = data.decode("utf-8", "replace")
            print("\n".join(sorted(set(re.findall(r'href="([^"]+)"', text)))))


if __name__ == "__main__":
    main()
