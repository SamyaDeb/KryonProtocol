# Stellar RPC Integration

The Rust runtime exposes `StellarRpcClient` and `RpcEventSource` traits so live
RPC ingestion can be swapped in without changing protocol logic.

Production adapter requirements:

- fetch events by ledger cursor and contract id
- persist event rows and ledger cursor in one Postgres transaction
- reject ledger regressions and duplicate replay keys
- retry RPC calls with bounded exponential backoff
- verify network passphrase before transaction submission
- submit signed XDR only through the configured signer provider
- preserve failed submission rows in `TxJob`

Environment:

```bash
STELLAR_NETWORK="testnet"
STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

For mainnet use:

```bash
STELLAR_NETWORK="mainnet"
STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
```
