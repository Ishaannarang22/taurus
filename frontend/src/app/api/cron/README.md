# Cron — Scheduled Execution Endpoint

## Endpoint

`GET /api/cron/run` (also accepts `POST`)

Runs all `active` strategies across all users: for each strategy, resolves the
user's paper account, then calls the execution engine. Results are aggregated and
returned. One strategy failure never aborts the batch.

## Authentication

The endpoint authenticates via a bearer token:

```
Authorization: Bearer <CRON_SECRET>
```

Set `CRON_SECRET` in your environment (`.env.local` locally, Vercel environment
variables in production). Keep it server-only — never expose it to the browser.

## Trigger locally

```bash
export CRON_SECRET=your-secret-here
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/run
```

## Trigger in production (manual)

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/run
```

## Vercel cron

`vercel.json` at the repo root configures Vercel to call this endpoint
automatically every 15 minutes. Vercel sends the `CRON_SECRET` automatically as
the `Authorization: Bearer` header when you set `CRON_SECRET` in the project
environment variables.

See: https://vercel.com/docs/cron-jobs

## Response shape

```json
{
  "ran": 2,
  "results": [
    {
      "strategyId": "...",
      "userId": "...",
      "accountId": "...",
      "result": {
        "ordersPlaced": 1,
        "tradesFilled": 1,
        "cashAfter": 98500.00,
        "notes": []
      }
    }
  ],
  "errors": []
}
```

`ran` is the count of strategies that completed without error. `errors` contains
one entry per strategy that failed, with enough context to identify the strategy
and the reason.
