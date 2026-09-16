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

```bash
# Re-register publisher (admin = same key as ORACLE_PUBLISHER_SECRET)
cd client
ORACLE_PUBLISHER_SECRET=<secret> npx tsx --env-file=.env.local scripts/update-oracle-publisher.ts
npm run dev:oracle
```

### Step 3 — If oracle contract is broken (redeploy)

```bash
cd client
ORACLE_PUBLISHER_SECRET=<secret> npx tsx --env-file=.env.local scripts/redeploy-oracle.ts

# Then update NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER in .env.local and Vercel:
echo "<new-id>" | vercel env add NEXT_PUBLIC_CONTRACT_ORACLE_ADAPTER production --scope samyadebs-projects --force
vercel --yes --prod --scope samyadebs-projects
```

## Prevention

- Oracle keeper publishes every 8s; contract guard max_age is 60s — 7x headroom
- Monitor alerts at 60s staleness (1 missed publish cycle headroom)
- Ensure oracle keeper Railway service has auto-restart on failure enabled
