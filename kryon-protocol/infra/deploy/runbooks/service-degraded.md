# Degraded infrastructure (`infra.rpc`, `infra.db`, `infra.db-replica`, `infra.api`, `infra.ws`, `economics.fees-vs-gas`)

These are the WARN-class checks (plus one PAGE for the API): the protocol is
safe, but something it depends on is limping — and every one of them is an
early warning for a PAGE elsewhere.

## `infra.rpc` — fallback in use, or slow

```
🟠 WARN infra.rpc — primary RPC rpc.example.com is down (ECONNREFUSED); serving from fallback rpc.testnet.arc.io
```

The read path uses a fallback transport in the configured order (`ARC_RPC_URLS`
first, the public RPC last). That is exactly what would hide a dead primary, so
this check probes **each endpoint individually** with `eth_blockNumber`.

- Serving from the fallback means the public RPC's rate limits now apply to the
  matcher and the keepers. Fix the paid provider before the limits bite.
- All endpoints down: every chain check is reporting `error` beside this one.
  That is a total outage of reads; treat it as a PAGE regardless of severity.

## `infra.db` — round-trip latency

Latency above the threshold usually means connection exhaustion or a long
query, not a slow disk. Check `pg_stat_activity` for idle-in-transaction
sessions. The keepers share this database; slow writes there become
`settlement.txjobs` later.

## `infra.db-replica` — replication lag

Only checked when `MONITOR_REPLICA_DATABASE_URL` is set (otherwise the check
reports `skip`, which is visible in `/status` — it is not a silent pass). Lag
means anything reading the replica (the API, the future status page) is showing
the past.

## `infra.api` — PAGE

`/api/health` non-2xx or unreachable. This is what a trader sees. Check the app
process, then the database, then the deployment.

## `infra.ws` — the streaming path

A full protocol round trip: the monitor opens a socket, sends
`{"type":"ping"}` and waits for `{"type":"pong"}` (`scripts/ws-server.ts`). A
server that accepts connections while answering nothing is up and useless, and a
connect-only check would call that healthy.

With `MONITOR_WS_URL` unset the check reports `skip` — visible in `/status`,
never a silent pass. The WS server also serves its own `/healthz` (200/503) and
`/metrics` on the same port; when this check fires, read those first:

```bash
curl -s localhost:8080/healthz | jq     # the server''s own view (WS_HEALTH_STALE_MS)
pm2 logs kryon-ws --lines 100
```

Common causes: the poller is stalled (its `/healthz` goes 503 after
`WS_HEALTH_STALE_MS`), connection or channel limits reached
(`WS_MAX_CONNECTIONS`, `WS_MAX_CHANNELS`), or backpressure disconnecting slow
clients (`WS_MAX_BUFFERED_BYTES`).

## `economics.fees-vs-gas`

```
🟠 WARN economics.fees-vs-gas — the fill mix is not paying for its gas — 2026-09-19: gas $42.00 > fees $18.00
```

`FeeAccrual` against `GasSpend`, per UTC day, both in 1e18 units so they are
directly comparable. Days with less than `MONITOR_FEES_GAS_MIN_USDC` of gas are
ignored as noise.

Causes worth separating:

1. **Too many small fills.** Batch size and `minFillNotional` decide this; look
   at `lastGasPerFill` in the matcher's counters.
2. **A keeper in a retry loop** burning gas on reverts — find it:
   ```sql
   SELECT service, SUM("costWei")/1e18 AS usd, SUM("txCount") FROM "GasSpend"
   WHERE "day" = current_date GROUP BY 1 ORDER BY 2 DESC;
   ```
3. **Fee rates below cost** for the current gas price. That is a governance
   decision (`04_ConfigureFees`), so a timelock operation.

Sustained, this is the protocol paying to trade. It is not an incident; it is a
business decision that needs making.
