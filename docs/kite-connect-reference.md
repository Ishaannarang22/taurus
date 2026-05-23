# Kite Connect v3 — Implementation Reference (Taurus)

Concise, implementation-focused reference for the Zerodha Kite Connect v3 API. We use the
Python `kiteconnect` lib for ingest, and direct REST/TypeScript from the Next.js app.

- API root: `https://api.kite.trade`
- Login host: `https://kite.zerodha.com/connect/login`
- Docs: <https://kite.trade/docs/connect/v3/>
- Python SDK: `pip install kiteconnect` — <https://kite.trade/docs/pykiteconnect/v4/>

All auth'd REST calls send header: `Authorization: token api_key:access_token`

---

## 1. Auth

Docs: <https://kite.trade/docs/connect/v3/user/>

Flow (interactive — cannot be done headlessly; needs Zerodha login + 2FA in a browser):

1. Redirect user to login URL:
   `https://kite.zerodha.com/connect/login?v=3&api_key=xxx`
2. After login + 2FA, Zerodha redirects to your registered redirect URL with
   `?request_token=yyy&action=login&status=success`.
3. Exchange `request_token` for `access_token`:
   `POST https://api.kite.trade/session/token` with `api_key`, `request_token`, `checksum`.
   - **checksum = SHA-256(api_key + request_token + api_secret)**
4. Use `access_token` in the `Authorization` header for all subsequent requests.

| Item | Value |
|---|---|
| Login endpoint | `GET kite.zerodha.com/connect/login?v=3&api_key=` |
| Session exchange | `POST /session/token` |
| Auth header | `Authorization: token api_key:access_token` |
| Token expiry | Daily (regulatory). Docs say "6 AM next day"; in practice tokens are flushed **5:00–7:30 AM IST**. Generate **after ~7:30 AM IST** for a full trading day. |
| Logout / invalidate | `DELETE /session/token?api_key=&access_token=` |

Python:

```python
from kiteconnect import KiteConnect

kite = KiteConnect(api_key="xxx")
print(kite.login_url())                      # step 1: send user here

# step 3: after redirect gives request_token
data = kite.generate_session("request_token_yyy", api_secret="zzz")
kite.set_access_token(data["access_token"])  # checksum computed by the lib internally
```

> The `access_token` CANNOT be obtained headlessly — interactive Zerodha login + 2FA is
> required once per day. Plan a manual/semi-automated daily re-login step. Never embed
> `api_secret` in client/Next.js code; do the session exchange server-side only.

---

## 2. Instruments

Docs: <https://kite.trade/docs/connect/v3/market-quotes/#instruments>

- `GET /instruments` — gzipped CSV of **all** tradable instruments (regenerated daily).
- `GET /instruments/:exchange` — CSV for one exchange (e.g. `/instruments/NSE`).
- Python: `kite.instruments()` or `kite.instruments("NSE")` → list of dicts (lib parses CSV).

CSV columns (12): `instrument_token, exchange_token, tradingsymbol, name, last_price,
expiry, strike, tick_size, lot_size, instrument_type, segment, exchange`

| Field | Notes |
|---|---|
| `instrument_token` | Numeric ID used for historical data + websocket subscription |
| `exchange_token` | Exchange-level numeric token |
| `tradingsymbol` | e.g. `RELIANCE`, `INFY` |
| `lot_size` | 1 for equity; >1 for F&O |
| `tick_size` | Min price increment (e.g. 0.05) |
| `instrument_type` | `EQ`, `FUT`, `CE`, `PE` |
| `segment` | e.g. `NSE`, `BSE`, `NFO-FUT`, `NFO-OPT` |
| `exchange` | `NSE`, `BSE`, `NFO`, `BFO`, `CDS`, `MCX` |

- **Unique key = (exchange, tradingsymbol)** — NOT the numeric token (tokens get reused after
  derivative expiry).
- `last_price` here is NOT real-time (snapshot at dump time).
- Symbol format for quote/order calls: `EXCHANGE:TRADINGSYMBOL` (e.g. `NSE:RELIANCE`).
- **Fetch once per day (~8:30 AM IST) and cache locally.**

To map tradingsymbol → instrument_token, build a dict from the dump:

```python
inst = kite.instruments("NSE")
token_by_symbol = {f"NSE:{r['tradingsymbol']}": r['instrument_token'] for r in inst}
```

> **NIFTY 500 constituents:** Kite has no index-constituents endpoint. Source the constituent
> list externally (NSE indices CSV / your own watchlist), then join on `tradingsymbol` against
> the instruments dump to resolve `instrument_token`.

---

## 3. Quotes

Docs: <https://kite.trade/docs/connect/v3/market-quotes/>

Instruments passed as `EXCHANGE:TRADINGSYMBOL`, repeated `i=` query params:
`?i=NSE:INFY&i=NSE:RELIANCE`

| Endpoint | Python | Max instruments/call | Returns |
|---|---|---|---|
| `/quote` | `kite.quote(...)` | 500 | Full: last_price, ohlc, volume, oi, depth (5 bid/ask), avg_price, circuit limits, buy/sell qty |
| `/quote/ohlc` | `kite.ohlc(...)` | 1000 | last_price + ohlc{open,high,low,close} |
| `/quote/ltp` | `kite.ltp(...)` | 1000 | last_price only |

```python
kite.ltp(["NSE:RELIANCE", "NSE:INFY"])
# {"NSE:RELIANCE": {"instrument_token": 738561, "last_price": 2895.0}, ...}

q = kite.quote(["NSE:RELIANCE"])
q["NSE:RELIANCE"]["last_price"]          # ltp
q["NSE:RELIANCE"]["ohlc"]                # {open, high, low, close}
q["NSE:RELIANCE"]["depth"]["buy"]        # 5-level order book
```

> Missing/invalid instruments are simply absent from the response — always check key existence.
> Prices are in INR.

---

## 4. Historical data

Docs: <https://kite.trade/docs/connect/v3/historical/>

- Endpoint: `GET /instruments/historical/:instrument_token/:interval`
- Python: `kite.historical_data(instrument_token, from_date, to_date, interval, continuous=False, oi=False)`
- `from_date`/`to_date`: `datetime` or `"yyyy-mm-dd"` (or `"yyyy-mm-dd hh:mm:ss"` for intraday).

Valid intervals + **max date range per single request** (split larger ranges into chunks):

| Interval | Max days/request |
|---|---|
| `minute` | 60 |
| `3minute` | 100 |
| `5minute` | 100 |
| `10minute` | 100 |
| `15minute` | 200 |
| `30minute` | 200 |
| `60minute` | 400 |
| `day` | 2000 |

(Limits per docs + Kite forum confirmation — see Sources.)

Candle shape: `[date, open, high, low, close, volume]`, plus `oi` appended when `oi=True`.
The Python lib returns a list of dicts: `{"date", "open", "high", "low", "close", "volume"[, "oi"]}`.

```python
from datetime import datetime
candles = kite.historical_data(
    instrument_token=738561,
    from_date="2026-01-01", to_date="2026-02-28",
    interval="day", continuous=False, oi=False,
)
```

- `continuous=True`: stitch expired futures contracts using a live contract's token.
- **Requires the paid Historical Data API subscription** (separate add-on on the developer
  console). 1-minute history goes back ~roughly years but each request capped at 60 days.
- **Rate limit: 3 requests/second** for historical (see §7). Throttle your chunked backfill.

---

## 5. Orders — REGULAR vs AMO

Docs: <https://kite.trade/docs/connect/v3/orders/>

- Place: `POST /orders/:variety` → `kite.place_order(...)`
- Modify: `PUT /orders/:variety/:order_id` → `kite.modify_order(...)`
- Cancel: `DELETE /orders/:variety/:order_id` → `kite.cancel_order(variety, order_id)`

`place_order` params:

| Param | Values / notes |
|---|---|
| `variety` | `regular`, `amo`, `co`, `iceberg`, `auction` |
| `exchange` | `NSE`, `BSE`, `NFO`, ... |
| `tradingsymbol` | e.g. `RELIANCE` |
| `transaction_type` | `BUY` / `SELL` |
| `quantity` | int |
| `product` | `CNC` (delivery equity), `MIS` (intraday), `NRML` (F&O carry), `MTF` |
| `order_type` | `MARKET`, `LIMIT`, `SL`, `SL-M` |
| `price` | required for `LIMIT` / `SL` |
| `trigger_price` | required for `SL` / `SL-M` |
| `validity` | `DAY`, `IOC`, `TTL` |
| `tag` | optional, free text (≤20 chars) for client-side correlation |
| `disclosed_quantity` | optional |

Returns `order_id` (string).

### AMO (After Market Orders) — what Taurus uses after hours

- `variety="amo"` (SDK constant `kite.VARIETY_AMO`).
- **Required when the market is closed** (outside 09:15–15:30 IST, weekends, holidays). Placing
  a `regular` order outside hours is rejected; AMO queues it for the **next** trading session.
- AMO accepts `order_type` `MARKET` and `LIMIT` (`SL`/`SL-M` are NOT supported for AMO).
- `product`: `CNC` / `NRML` / `MIS` as applicable. `validity` `DAY`.
- Difference vs regular: regular hits the exchange immediately during market hours; AMO is held
  by the broker and submitted at the next session open.

```python
# Market is closed -> place an AMO
order_id = kite.place_order(
    variety=kite.VARIETY_AMO,
    exchange=kite.EXCHANGE_NSE,
    tradingsymbol="RELIANCE",
    transaction_type=kite.TRANSACTION_TYPE_BUY,
    quantity=1,
    product=kite.PRODUCT_CNC,
    order_type=kite.ORDER_TYPE_LIMIT,   # MARKET or LIMIT only for AMO
    price=2800,
    validity=kite.VALIDITY_DAY,
    tag="taurus",
)

kite.modify_order(variety="amo", order_id=order_id, price=2810)
kite.cancel_order(variety="amo", order_id=order_id)
```

### Reading status

- `kite.orders()` → all of today's orders.
- `kite.order_history(order_id)` → full state progression for one order.

Statuses: terminal `COMPLETE`, `CANCELLED`, `REJECTED`; interim `PUT ORDER REQ RECEIVED`,
`VALIDATION PENDING`, `OPEN PENDING`, `OPEN`, `TRIGGER PENDING`, `MODIFY VALIDATION PENDING`,
`MODIFY PENDING`, `CANCEL PENDING`. Only `OPEN` / pending orders are modifiable/cancellable.

---

## 6. Market hours / session

- NSE/BSE equity: **09:15–15:30 IST, Mon–Fri**, excluding exchange holidays.
- Kite has **no "is market open" endpoint** — infer from the wall clock in IST.

Decision rule for Taurus:

```
now_ist = current time in Asia/Kolkata
is_open = (weekday is Mon–Fri)
          and (not an NSE holiday)
          and (09:15 <= now_ist.time() <= 15:30)
variety = "regular" if is_open else "amo"
```

Maintain a holiday calendar (NSE publishes annually); treat unknown days conservatively as
closed → AMO. **Right now it is after hours → use AMO.**

---

## 7. Rate limits & exceptions

Docs: <https://kite.trade/docs/connect/v3/exceptions/>

| Category | Limit |
|---|---|
| Quote (`/quote*`) | 1 req/sec |
| Historical | 3 req/sec |
| Order placement | 10 req/sec |
| All other endpoints | 10 req/sec |
| Orders/min | 400 |
| Orders/day | 5,000 |
| Modifications per order | 25 |

`from kiteconnect.exceptions import ...`

| Exception | Meaning / action |
|---|---|
| `TokenException` | 403 — session expired/invalid. **Clear session, re-login** (daily expiry). |
| `InputException` | Missing/invalid params. Fix the request. |
| `OrderException` | Order placement/retrieval failure. |
| `MarginException` | Insufficient funds. |
| `HoldingException` | Insufficient holdings to sell. |
| `NetworkException` | Can't reach OMS — retry with backoff. |
| `DataException` | Internal Kite parsing failure. |
| `GeneralException` | Unclassified, rare. |
| `PermissionException` | Endpoint not permitted for the app/subscription. |

---

## Gotchas for Taurus

- **Daily token:** `access_token` dies every morning (~7:30 AM IST flush). Build a daily
  re-login step; it's interactive (login + 2FA) and cannot be fully headless. On
  `TokenException`, force re-login.
- **AMO after hours:** Outside 09:15–15:30 IST / weekends / holidays, use `variety="amo"`
  with `order_type` MARKET/LIMIT only (no SL). It executes next session. We're after hours now.
- **Historical subscription:** `historical_data` needs the paid add-on; respect 3 req/sec and
  chunk by the per-interval day caps (minute=60, day=2000).
- **INR pricing:** all prices/`tick_size` in INR; `tick_size` (e.g. 0.05) constrains LIMIT prices.
- **NSE symbol format:** quotes/orders use `EXCHANGE:TRADINGSYMBOL` (`NSE:RELIANCE`); resolve
  `instrument_token` from the daily instruments dump keyed on `(exchange, tradingsymbol)`.
- **Secret hygiene:** never put `api_secret` in the Next.js client; do session exchange server-side.

---

### Sources
- User/auth: <https://kite.trade/docs/connect/v3/user/>
- Instruments & quotes: <https://kite.trade/docs/connect/v3/market-quotes/>
- Historical: <https://kite.trade/docs/connect/v3/historical/>
- Orders: <https://kite.trade/docs/connect/v3/orders/>
- Exceptions & rate limits: <https://kite.trade/docs/connect/v3/exceptions/>
- Historical day-range limits confirmed via Kite forum:
  <https://kite.trade/forum/discussion/11460/kite-historical-data-interval-date-range>
- Token expiry timing: <https://kite.trade/forum/discussion/3468/access-token-expiry-time-everyday>
