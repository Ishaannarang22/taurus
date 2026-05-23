#!/usr/bin/env python3
"""
Ingest daily OHLCV for the NIFTY 500 from Kite Connect into Supabase price_bars
(₹ / NSE). Replaces the earlier US/yfinance data.

Kite historical 'day' interval allows up to ~2000 days per request, so 5y fits
in one call per symbol. Historical API is rate-limited to ~3 req/s, so we throttle.

Run (token must be fresh — see data/kite_login.py):
    KITE_DAYS=1825 python3 data/ingest_prices_kite.py
"""

import datetime as dt
import io
import os
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd
from kiteconnect import KiteConnect
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
DAYS = int(os.environ.get("KITE_DAYS", "1825"))  # ~5y
HIST_SLEEP = 0.34  # ~3 req/s historical limit
UPSERT_BATCH = 1000


def rd(key: str, fname: str = "frontend/.env.local"):
    for line in (ROOT / fname).read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return None


def nifty500_symbols():
    urls = [
        "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv",
        "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
    ]
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                df = pd.read_csv(io.StringIO(r.read().decode()))
            syms = [str(s).strip().upper() for s in df["Symbol"]]
            print(f"NIFTY 500 list: {len(syms)} symbols from {u}", flush=True)
            return syms
        except Exception as e:  # noqa: BLE001
            print(f"  fetch failed {u}: {e}", flush=True)
    sys.exit("could not fetch NIFTY 500 constituent list")


def main():
    kite = KiteConnect(api_key=rd("KITE_API_KEY"))
    kite.set_access_token(rd("KITE_ACCESS_TOKEN"))

    print("loading NSE instruments dump...", flush=True)
    instruments = kite.instruments("NSE")
    token_of = {
        i["tradingsymbol"]: i["instrument_token"]
        for i in instruments
        if i.get("instrument_type") == "EQ" and i.get("segment") == "NSE"
    }
    print(f"  {len(token_of)} NSE equities", flush=True)

    symbols = nifty500_symbols()
    to_date = dt.date.today()
    from_date = to_date - dt.timedelta(days=DAYS)

    rows = []
    missing = []
    for n, sym in enumerate(symbols, 1):
        tok = token_of.get(sym)
        if not tok:
            missing.append(sym)
            continue
        try:
            candles = kite.historical_data(tok, from_date, to_date, "day")
        except Exception as e:  # noqa: BLE001
            print(f"  hist fail {sym}: {e}", flush=True)
            time.sleep(0.5)
            continue
        for c in candles:
            rows.append(
                {
                    "symbol": sym,
                    "bar_date": c["date"].date().isoformat(),
                    "interval": "1d",
                    "open": c["open"],
                    "high": c["high"],
                    "low": c["low"],
                    "close": c["close"],
                    "adj_close": c["close"],  # Kite equities: unadjusted close
                    "volume": int(c["volume"]),
                }
            )
        if n % 50 == 0:
            print(f"  {n}/{len(symbols)} symbols, {len(rows):,} rows", flush=True)
        time.sleep(HIST_SLEEP)

    print(f"fetched {len(rows):,} rows; {len(missing)} symbols not found on NSE", flush=True)

    sb = create_client(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"))
    done = 0
    for i in range(0, len(rows), UPSERT_BATCH):
        batch = rows[i : i + UPSERT_BATCH]
        sb.table("price_bars").upsert(batch, on_conflict="symbol,bar_date,interval").execute()
        done += len(batch)
        if done % (UPSERT_BATCH * 20) == 0 or done == len(rows):
            print(f"  upserted {done:,}/{len(rows):,}", flush=True)

    print(f"DONE: {done:,} NIFTY 500 daily bars in price_bars (₹/NSE)", flush=True)
    if missing:
        print(f"missing ({len(missing)}): {', '.join(missing[:20])}{'...' if len(missing) > 20 else ''}", flush=True)


if __name__ == "__main__":
    main()
