# /api/cron/agent — Autonomous agentic cron route

Runs the agentic trading harness across all paper accounts on a schedule.

## Authentication

`Authorization: Bearer <CRON_SECRET>` (same secret as `/api/cron/run`).
Requests without a valid token receive `401 Unauthorized`.

## Scheduling

Add to `vercel.json` alongside the existing engine cron:

```json
{
  "path": "/api/cron/agent",
  "schedule": "0 */4 * * *"
}
```

(Every 4 hours is a reasonable default; adjust to taste.)

## Behaviour

1. Loads up to `MAX_ACCOUNTS_PER_TICK` (10) paper accounts via the service client.
2. For each account, runs `runAgent` with a standing alignment instruction:
   - Check positions vs. target weights.
   - Rebalance if drift > 10%.
   - Do nothing if already aligned.
3. Accounts are processed **sequentially** with a 2-second delay between each
   to respect Alpha Vantage's 5-request/minute free-tier limit.
4. Fail-soft: one account failure never aborts the rest.

## Response

```json
{
  "ran": 3,
  "results": [
    { "userId": "...", "accountId": "...", "runId": "...", "summary": "...", "ordersPlaced": 2 }
  ],
  "errors": []
}
```

## Local testing

```bash
curl -X POST http://localhost:3000/api/cron/agent \
     -H "Authorization: Bearer $CRON_SECRET"
```

## Integration note

`runAgent` is imported from `@/lib/agent/harness` (Agent I's branch).
Until that branch is merged, a stub shim is active — calls return an
inert result with no side effects. Remove the shim block after merge.
