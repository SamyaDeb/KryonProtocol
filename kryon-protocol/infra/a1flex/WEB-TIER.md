# Running the web tier on the VM behind a Cloudflare Tunnel

Step-by-step. Companion to [`README.md`](./README.md), which covers the A1.Flex
host itself; this document covers only the web tier and the public edge.

---

## Why this change

On 2026-08-22 all three public deployments returned `503 readiness_unavailable`
at once:

| Deployment | `/api/ready` |
|---|---|
| `www.kryonprotocol.live` (Vercel) | `503 readiness_unavailable` |
| `client-eight-mu-71.vercel.app` (Vercel) | `503 readiness_unavailable` |
| `kryon-client.kryon.workers.dev` (CF Workers) | `503 readiness_unavailable` |

One cause: the database moved to the services VM with
`listen_addresses=localhost`. **No serverless web tier can reach it.** They have
no route to the box, and no static egress IP to allowlist even if 5432 were
opened. The keepers kept running the whole time — the oracle published on
mainnet 2 minutes before this was written — but nothing could *serve* what they
wrote.

Putting Next on the same host makes the database a loopback call again. The
public edge becomes a Cloudflare Tunnel, which dials **outbound** from the box.
Nothing is exposed inbound: no VCN ingress rule, no public 5432, no public 3000.
That also fixes, for free, the WebSocket problem that has stood since July — the
ws-server was unreachable because the VCN Security List rule for 8080 was never
added. Through a tunnel there is no rule to add.

```
browser ──https──▶ Cloudflare edge ──(outbound tunnel)──▶ VM
                                                          ├─ kryon-web  :3000  (Next)
                                                          ├─ kryon-ws   :8080  (mainnet)
                                                          ├─ kryon-testnet-ws :8081
                                                          ├─ 7 mainnet keepers
                                                          └─ postgres :5432 (loopback)
```

---

## Before you start

- [ ] **A1.Flex box exists and the mainnet fleet is migrated onto it.**
      Steps 1–4 of [`README.md`](./README.md). The 945 MB micro box **cannot**
      host this — it already sits at ~85% memory with Postgres and 7 keepers;
      `next build` alone will OOM it. This step is not optional.
- [ ] You can log in to the Cloudflare account (`sammodeb28@gmail.com`,
      account `b8a23edf0ffbfe1137d1d672b0017238`).
- [ ] You can log in to **Name.com** to change nameservers. ⚠️ The
      `kryonprotocol.live` registrant email is a *different* Gmail than the one
      above — the same mismatch behind the 2026-08-16 ICANN suspension. Confirm
      you can get into that account before starting, because step 1 is a hard
      dependency for everything after it.

---

## Step 1 — Move DNS to Cloudflare

Cloudflare Tunnel routes by hostname, and a tunnel hostname resolves through a
`*.cfargotunnel.com` CNAME that **only works on Cloudflare DNS**. Name.com
cannot host it. So the zone has to move. The domain stays registered at
Name.com — only the nameservers change.

1. Cloudflare dashboard → **Add a site** → `kryonprotocol.live` → Free plan.
2. Cloudflare scans existing records. **Delete the three Vercel records** it
   imports (`A @ → 216.198.79.1`, `A @ → 64.29.17.1`,
   `CNAME www → cname.vercel-dns.com`). The tunnel creates its own in step 4;
   leaving these means the edge races Vercel and serves the dead deployment.
   The zone has no MX/TXT/CAA records, so nothing else is at risk.
3. Cloudflare shows two assigned nameservers. In **Name.com → Domain →
   Nameservers**, replace all four `ns[1-4]*.name.com` entries with them.
4. Wait for Cloudflare to report the zone **Active** (usually minutes, up to
   24 h). Verify:
   ```bash
   dig +short NS kryonprotocol.live      # must return the two Cloudflare NS
   ```

**Do not proceed until this returns Cloudflare nameservers.** Everything below
depends on it.

---

## Step 2 — Configure the environment on the box

```bash
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP>
cd ~/kryon/client
```

Edit `.env.local`. These are the ones that matter for the web tier — the rest
carries over from the keeper config unchanged:

```bash
# Both networks, both loopback. lib/db.ts refuses to cross-serve, so an unset
# testnet URL means every testnet API route throws — it will not quietly fall
# back to mainnet rows.
DATABASE_URL_MAINNET=postgresql://kryon:<PW>@localhost:5432/kryon_mainnet?sslmode=disable
DATABASE_URL_TESTNET=postgresql://kryon:<PW>@localhost:5432/kryon_testnet?sslmode=disable

# Declare each venue's liveness honestly. Unset means "only the primary network
# is live", which is what made the banner call MAINNET dead while it was the
# only venue with keepers running.
NEXT_PUBLIC_MAINNET_KEEPERS_LIVE=true
NEXT_PUBLIC_TESTNET_KEEPERS_LIVE=false     # → true once step 6 is done

# WebSocket feeds, one hostname per network — one ws-server process tails
# exactly one database.
NEXT_PUBLIC_WS_URL_MAINNET=wss://ws.kryonprotocol.live
NEXT_PUBLIC_WS_URL_TESTNET=wss://ws-testnet.kryonprotocol.live
NEXT_PUBLIC_WS_URL=                         # legacy single-network var; leave empty

NEXT_PUBLIC_APP_URL=https://kryonprotocol.live   # empty string crashes `next build`
NEXT_PUBLIC_STELLAR_NETWORK=mainnet              # the primary venue

# The 43-day silent outage happened because the monitor had nowhere to shout.
ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

`<PW>` is the password `bootstrap.sh` printed once, also saved at
`~/.kryon-db-password`.

Sanity-check both databases before building:

```bash
psql "$DATABASE_URL_MAINNET" -c 'SELECT count(*) FROM "Market";'
psql "$DATABASE_URL_TESTNET" -c 'SELECT count(*) FROM "Market";'
```

---

## Step 3 — Create the tunnel

```bash
sudo dnf install -y https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.rpm
cloudflared tunnel login        # prints a URL — open it, pick kryonprotocol.live
cloudflared tunnel create kryon # prints the TUNNEL-ID and credentials path
```

Install the ingress config:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/kryon/kryon-protocol/infra/a1flex/cloudflared-config.yml /etc/cloudflared/config.yml
sudo sed -i "s/<TUNNEL-ID>/<the-id-just-printed>/g" /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
sudo cloudflared --config /etc/cloudflared/config.yml validate
```

---

## Step 4 — Build, route and start

```bash
bash ~/kryon/kryon-protocol/infra/a1flex/setup-web-tier.sh
```

It refuses to build unless both `DATABASE_URL_*` are set, builds the app and the
Docusaurus `/docs` export, installs cloudflared as a systemd service, points all
four hostnames at the tunnel, starts `kryon-web` under pm2, and verifies
`/api/ready` on both networks locally and publicly.

The app binds to `127.0.0.1:3000` — cloudflared is the only thing that can reach
it. Without that bind Next listens on `0.0.0.0` and the site is also served
unencrypted on `<public-ip>:3000`, straight past the tunnel's TLS.

---

## Step 5 — Verify

```bash
curl -s https://kryonprotocol.live/api/ready | jq          # ok:true, network:mainnet
curl -s 'https://kryonprotocol.live/api/ready?network=testnet' | jq
curl -s https://kryonprotocol.live/api/markets/BTC-PERP | jq '.markPrice,.updatedAt'
curl -sI https://kryonprotocol.live | grep -i content-security-policy
```

- [ ] `/api/ready` is `ok:true` on **both** networks
- [ ] `markPrice` is fresh (the oracle publishes continuously — a timestamp more
      than a few minutes old means the keeper is down, not the web tier)
- [ ] Order book renders on `/trade/BTC-PERP` with no degraded banner on mainnet
- [ ] Browser devtools shows the WebSocket connected to
      `wss://ws.kryonprotocol.live`, not falling back to REST polling
- [ ] `/docs` loads

---

## Step 6 — Bring testnet up (this is what removes the banner)

The testnet banner you are seeing now is **correct** — testnet genuinely has no
keepers. `ecosystem.testnet.config.cjs` exists but has never been started; the
micro box had no memory for a second fleet. A1.Flex does.

```bash
cd ~/kryon/client
# Fund three NEW testnet accounts — never reuse the mainnet operator keys.
# Two processes signing with one key race the same sequence number and both get
# TxBadSeq; that is what killed the laptop fleet in July.
cp .env.testnet.example .env.testnet   # then fill in the three secrets
pm2 start ecosystem.testnet.config.cjs
pm2 save
```

Then flip `NEXT_PUBLIC_TESTNET_KEEPERS_LIVE=true` and rebuild (step 7) — the
flag is inlined into the client bundle at build time, so a restart alone will
not pick it up.

---

## Step 7 — Redeploying, from now on

```bash
cd ~/kryon && git pull
bash kryon-protocol/infra/a1flex/setup-web-tier.sh
```

A failed build leaves the previous bundle serving; `next start` never compiles.

---

## Step 8 — Decommission the old web tiers

Only after step 5 passes. Leaving them up means two deployments answering for
Kryon, one of them permanently 503.

- [ ] Vercel → project → Settings → **Delete** (or at minimum remove the
      `kryonprotocol.live` domain assignment)
- [ ] `npx wrangler delete kryon-client` for the Workers deployment
- [ ] Disable the `deploy-production.yml` GitHub workflow — it still pushes to
      Workers on every merge to `main` and will resurrect the dead tier
- [ ] Rotate the credentials that were pasted into chat transcripts: the
      Cloudflare API token and the Upstash REST token
- [ ] Terminate the micro instance (`92.4.91.30`) — **last**, and only once
      `pm2 status` on the new box shows all fleets online

---

## Rollback

The tunnel is the only thing standing between the browser and the box, so
rolling back is stopping it:

```bash
sudo systemctl stop cloudflared     # site goes dark, keepers keep running
pm2 restart kryon-web               # or: pm2 stop kryon-web
```

Nothing about the keeper fleets or the database depends on the web tier. A bad
deploy costs the site, never the protocol state.
