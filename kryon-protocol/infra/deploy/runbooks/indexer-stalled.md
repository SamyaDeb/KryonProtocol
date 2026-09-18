# Indexer stalled (`indexer.lag`)

**PAGE.** The indexer is the only writer of on-chain truth into Postgres. When
it stops, the API serves stale balances, the matcher matches against a book
that no longer exists, the reconciler cannot tell a settled fill from a lost
one, and `funding.freshness`'s cross-check goes quiet. Nothing else notices.

## Symptom

```
🔴 PAGE indexer.lag — indexer is N block(s) / Xm behind the head (limits 120 blocks, 60s)
🔴 PAGE indexer.lag — the indexer has never written a cursor
```

Lag is measured two ways: blocks between `BlockCursor` and the head, and
seconds between that cursor block's timestamp and the head's. Either exceeding
its limit fires.

## First checks

```bash
pm2 logs kryon-indexer --lines 200            # is it running, and what is it saying?
psql "$DATABASE_URL" -c 'SELECT * FROM "BlockCursor" WHERE "network" = '"'"'arc-testnet'"'"''
cast block-number --rpc-url "$ARC_RPC_URL"    # the head it should be at
curl -s localhost:9464/status | jq '.checks[] | select(.key=="indexer.lag")'
```

## Likely causes

1. **The process is dead or crash-looping.** `pm2 list`, then the error log.
   The indexer writes each window and its cursor in one transaction, so a crash
   never leaves a partial window: it is safe to restart.
2. **The RPC is failing or rate-limiting `eth_getLogs`.** Check `infra.rpc`. The
   indexer narrows its window on failure; a log full of window shrinks means the
   provider, not the indexer.
3. **The database is refusing writes** (disk, connections, a lock). Check
   `infra.db` and `pg_stat_activity`.
4. **A decode error on a new event** after a contract upgrade — the log will
   name the topic. That needs the ABI regenerated (`npm run wagmi:generate`)
   and a deploy, not a restart.
5. **Reorg handling**: the cursor stores a block hash; a mismatch makes it walk
   back. Frequent rewinds point at an unstable RPC node.

## Actions

```bash
pm2 restart kryon-indexer
# Watch it catch up: the lag should fall every tick.
watch -n5 'psql "$DATABASE_URL" -c "SELECT \"blockNumber\" FROM \"BlockCursor\""'
```

If it cannot catch up because it is far behind (hours), let it run: it indexes
in windows and the alert resolves when it is inside the limits again. Do not
truncate tables to "start fresh" — the derived tables are rebuildable from
`ProtocolEvent`, but only if `ProtocolEvent` is intact.

While the indexer is behind, expect and ignore these secondary alerts:
`settlement.fills` (`indexer-lag` kind, WARN), and any liquidation backlog that
resolves as soon as positions are re-projected.

## Escalation

Lag past ~15 minutes on a network with open interest: wake someone. Withdrawals
and the API are serving stale state the whole time.
