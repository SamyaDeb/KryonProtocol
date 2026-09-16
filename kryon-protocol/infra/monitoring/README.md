# Monitoring

Production monitors must alert on:

- stale oracle snapshots
- oracle confidence beyond market guard
- failed liquidation attempts
- accounts below maintenance margin
- SLP NAV/custody reconciliation mismatch
- storage TTL below safety threshold
- keeper sequence/account failures
- governance upgrade announcements

Implemented baseline:

- `services/monitoring` evaluates stale oracle feeds, bad debt, settlement
  failures, liquidation backlog, and matcher queue depth.
- `services/keepers` provides deterministic inputs for funding, oracle, and
  liquidation keeper health checks.

Production daemon requirements:

- export Prometheus/OpenTelemetry metrics
- persist alert history
- page on critical alerts
- include ledger sequence, contract id, market id, and tx hash in every alert
- run independent canaries for oracle freshness and liquidation liveness
