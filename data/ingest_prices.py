#!/usr/bin/env python3
"""
Ingest daily OHLCV bars for the S&P 500 from yfinance into the Supabase
`price_bars` table — our own historical market-data store, so backtests and the
agent don't depend on Alpha Vantage's per-day request cap.

Why daily (not 1-minute): Yahoo/yfinance only serves 1-minute data for the last
~7 days; multi-year history is only available at daily granularity.

Usage:
    export SUPABASE_URL=...            # https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=...   # service role (server-only)
    PRICE_PERIOD=5y python3 data/ingest_prices.py

Env:
    PRICE_PERIOD   yfinance period (default "5y"; e.g. "1y", "2y", "max")
"""

import math
import os
import sys
import time

import pandas as pd
import yfinance as yf
from supabase import create_client

PERIOD = os.environ.get("PRICE_PERIOD", "5y")
INTERVAL = "1d"
UPSERT_BATCH = 1000      # rows per Supabase upsert request
DOWNLOAD_CHUNK = 80      # tickers per yfinance download call

SP500_CSV = (
    "https://raw.githubusercontent.com/datasets/"
    "s-and-p-500-companies/main/data/constituents.csv"
)


def num(v):
    """Float or None (NaN -> None)."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def vol(v):
    f = num(v)
    return int(f) if f is not None else None


def get_sp500_tickers():
    df = pd.read_csv(SP500_CSV)
    # yfinance uses '-' where Wikipedia/CSV use '.' (e.g. BRK.B -> BRK-B)
    syms = [str(s).strip().upper().replace(".", "-") for s in df["Symbol"]]
    return sorted({s for s in syms if s})


def fetch_rows(tickers):
    rows = []
    for i in range(0, len(tickers), DOWNLOAD_CHUNK):
        chunk = tickers[i : i + DOWNLOAD_CHUNK]
        data = yf.download(
            chunk,
            period=PERIOD,
            interval=INTERVAL,
            group_by="ticker",
            auto_adjust=False,
            threads=True,
            progress=False,
        )
        for sym in chunk:
            try:
                sub = data[sym] if len(chunk) > 1 else data
            except KeyError:
                continue
            if sub is None or sub.empty:
                continue
            sub = sub.dropna(subset=["Close"])
            for idx, r in sub.iterrows():
                rows.append(
                    {
                        "symbol": sym,
                        "bar_date": idx.date().isoformat(),
                        "interval": INTERVAL,
                        "open": num(r.get("Open")),
                        "high": num(r.get("High")),
                        "low": num(r.get("Low")),
                        "close": num(r.get("Close")),
                        "adj_close": num(r.get("Adj Close")),
                        "volume": vol(r.get("Volume")),
                    }
                )
        print(
            f"  fetched {min(i + DOWNLOAD_CHUNK, len(tickers))}/{len(tickers)} "
            f"tickers, {len(rows):,} rows so far",
            flush=True,
        )
    # Drop any rows missing the required close (NOT NULL in the table).
    return [r for r in rows if r["close"] is not None]


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

    print(f"S&P 500 daily bars, period={PERIOD}", flush=True)
    tickers = get_sp500_tickers()
    print(f"{len(tickers)} tickers", flush=True)

    t0 = time.time()
    rows = fetch_rows(tickers)
    print(f"fetched {len(rows):,} rows in {time.time() - t0:.0f}s", flush=True)

    sb = create_client(url, key)
    inserted = 0
    for i in range(0, len(rows), UPSERT_BATCH):
        batch = rows[i : i + UPSERT_BATCH]
        sb.table("price_bars").upsert(
            batch, on_conflict="symbol,bar_date,interval"
        ).execute()
        inserted += len(batch)
        if inserted % (UPSERT_BATCH * 20) == 0 or inserted == len(rows):
            print(f"  upserted {inserted:,}/{len(rows):,}", flush=True)

    print(f"DONE: {inserted:,} rows upserted into price_bars", flush=True)


if __name__ == "__main__":
    main()
