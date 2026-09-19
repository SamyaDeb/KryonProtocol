# Oracle Failure Procedure

## Symptoms

- Monitor shows: `oracle-freshness FAIL: oracle XLM is Xs stale`
- Trades fail with "oracle price too stale" on-chain error
- Mark price on UI shows stale / frozen value

## Diagnosis

```bash
# Check oracle keeper process
railway logs --service oracle-keeper --lines 50

# Check last published price on-chain (via Soroban RPC)
cd client && node -e "
const { Keypair, Account, Contract, TransactionBuilder, nativeToScVal, xdr, rpc } = require('@stellar/stellar-sdk');
const server = new rpc.Server('https://soroban-testnet.stellar.org');
const kp = Keypair.random();
const acc = new Account(kp.publicKey(), '100');
const c = new Contract(process.env.NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER);
const tx = new TransactionBuilder(acc, { fee: '500000', networkPassphrase: 'Test SDF Network ; September 2015' })
  .addOperation(c.call('get_price', nativeToScVal('XLM', {type:'symbol'}), xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('RedStone')])))
  .setTimeout(10).build();
server.simulateTransaction(tx).then(r => console.log(JSON.stringify(r.result?.retval?.toXDR('base64'))));
" 2>&1

# Check Binance API is reachable
curl -s 'https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT'
```

## Recovery steps

### Step 1 — Restart oracle keeper

```bash
# Railway: trigger a redeploy of the oracle-keeper service
railway redeploy --service oracle-keeper

# Local fallback (keeps publishing while Railway restarts):
cd client && npm run dev:oracle
```

### Step 2 — If restart doesn't fix it (authorization error)

The oracle publisher key may no longer be authorized for the feed.

Publishers are set as a whole set by `OracleAdapter.setPublishers(address[])`,
which only the timelock can call (RISK_ADMIN). There is no fast path: schedule
the new set through the governance Safe as in `timelock-operations.md`, and keep
the current publishers running until it executes.

```bash
# Which addresses are publishers right now (read-only)
cast call <ORACLE_ADAPTER> "publishers()(address[])" --rpc-url $ARC_RPC
# Restart the publisher process with a key that is in that set
cd client && npm run dev:oracle
```

### Step 3 — If oracle contract is broken (redeploy)

```bash
cd client
ORACLE_PUBLISHER_SECRET=<secret> npx tsx --env-file=.env.local scripts/redeploy-oracle.ts

# Then update NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER in .env.local and Vercel:
echo "<new-id>" | vercel env add NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER production --scope <VERCEL_TEAM> --force
vercel --yes --prod --scope <VERCEL_TEAM>
```

## Prevention

- Oracle keeper publishes every 8s; contract guard max_age is 60s — 7x headroom
- Monitor alerts at 60s staleness (1 missed publish cycle headroom)
- Ensure oracle keeper Railway service has auto-restart on failure enabled

## Arc: stale feeds block withdrawals (hard requirement)

On Arc, `Engine` values every position an account holds at the oracle index. If **any** market the
account holds has a stale, too-uncertain or inactive feed, that account can't withdraw, trade, or be
liquidated. This fail-closed behaviour is intended.

- **The oracle keeper must publish every feed whose market has open interest > 0, including
  inactive markets.** Deactivating a market in `RiskParams` doesn't stop the keeper's obligation.
- **Monitor:** alert when any feed with OI > 0 is older than `maxAge / 2` (7.5s on mainnet).
- **Delisting a market:** first reduce its OI to 0 (reduce-only trading, liquidations, backstop
  unwind). Only then deactivate its feed with `OracleAdapter.setFeed(id, active = false)`.
  Never deactivate a feed while any position is open.
- **Recovery after an outage:** once publishers are back, the first update that passes quorum,
  spread and the reference check re-anchors the feed (`PriceReanchored` event), even if the price
  moved more than `maxJumpBps` during the outage. Check the re-anchored price against the
  reference before re-opening the matcher.
- `99_VerifyDeployment` fails if any configured market's feed isn't listed and active.

## Arc monitor alerts and what each one means

The monitor (`client/lib/monitor/checks/oracle.ts`) reports **every feed by
name**, one result per market, so one stale feed can never hide the other seven.

| Alert | Severity | Means |
|---|---|---|
| `oracle.freshness:<SYM>` | PAGE | Past `maxOracleAge × MONITOR_ORACLE_STALE_FRACTION` (default half). The wording says whether it is approaching the bound or already past it — past it, trading, liquidation and withdrawals are blocked for that market's holders. |
| `oracle.freshness:adapter` | PAGE | `OracleAdapter.paused()`: no feed can update at all. |
| `oracle.quorum:<SYM>` | WARN | Fewer publishers are fresh than `minPublishers`, so the next push cannot aggregate. This is the early warning for the PAGE above — usually one publisher process down. |
| `oracle.divergence:<SYM>` | WARN | Within `MONITOR_ORACLE_DIVERGENCE_FRACTION` of the on-chain `maxDivergenceBps`, i.e. the adapter is about to start skipping updates. Also fires when a *required* reference is unavailable. |
| `oracle.flatline:<SYM>` | WARN | The same price published repeatedly for longer than `MONITOR_ORACLE_FLATLINE_SECS`. A fresh feed with a stuck source looks perfectly healthy to a freshness check. |

Freshness is measured exactly as `OracleAdapter._validate` measures it: the
**older** of `publishTime` and `writeTime` against the block timestamp, bounded
by the market's `maxOracleAge` (the value `Engine` passes to `getPrice`). A feed
whose price was published long before it landed is stale on the publish side,
and the monitor sees that.

A market with **no open interest** reports `skip`, not `pass`: nothing is
blocked, and there is nothing to page about. Its feed still needs to be fresh
before anyone opens a position in it.

### Diagnosis on Arc

```bash
cd client
curl -s localhost:9464/status | jq '.checks[] | select(.check|startswith("oracle."))'
pm2 logs kryon-oracle kryon-oracle-2 --lines 100    # both publishers
npx tsx scripts/monitor.ts --once                   # one tick, printed
```

Then, in order: is the publisher process alive; does its key hold
`PUBLISHER_ROLE` (`governance.roles` would also be firing); does it have gas
(`gas.balance:publisher`, and remember gas is USDC); are its venues reachable
(the keeper logs `source dropped as outlier` and `feed backing off`).
