# Kryon go-live — the whole path, in order

From the current state (site 503, mainnet keepers running, testnet dark) to a
fully working production site.

**This is the ordered path.** [`README.md`](./README.md) and
[`WEB-TIER.md`](./WEB-TIER.md) hold the reasoning behind individual phases;
this file is what you follow top to bottom.

Legend: 🧑 you must do this by hand · 🤖 a script does it · ⏱ rough time

---

## Where things stand

| | State |
|---|---|
| Mainnet keepers | ✅ running on the micro box — oracle published today |
| Mainnet contracts | ✅ live since 2026-07-07 |
| Database | ✅ PG16 on the VM, loopback-only |
| **Public site** | ❌ **503 on all three deployments** (Vercel ×2, CF Workers) |
| Testnet keepers | ❌ never started |
| Operator wallets | ⚠️ 2.99 / 3.65 / 9.21 XLM against a 25 XLM alert threshold |
| Alerting | ❌ `ALERT_WEBHOOK_URL` unset |

The site is down because Postgres listens on loopback and no serverless web tier
can reach it. Everything below fixes that by moving the app onto the box.

---

## Phase 0 — Preflight ⏱ 10 min

Confirm you can get into all three of these **before** starting. Phase 5 is a
hard dependency for the rest and is the one most likely to block you.

- [ ] 🧑 **Oracle Cloud** console login (tenancy `sammodeb28@gmail.com`)
- [ ] 🧑 **Cloudflare** login — account `b8a23edf0ffbfe1137d1d672b0017238`
- [ ] 🧑 **Name.com** login for `kryonprotocol.live`
      ⚠️ the registrant email is a **different Gmail** than the above — the same
      mismatch behind the 2026-08-16 ICANN suspension. Verify you can log in
      now; if you cannot, stop and recover that account first, because Phase 5
      cannot be worked around.
- [ ] 🧑 A Discord (or Slack) webhook URL for alerts — create it now, you need
      it in Phase 6. The 2026-07 outage ran **43 days** unnoticed purely because
      this was unset.

Check your laptop tooling (already present as of 2026-08-22):

```bash
ls ~/.oci-cli-venv/bin/oci        # OCI CLI
ls ~/.ssh/kryon-vm.pub            # public key uploaded to new instances
ls ~/.ssh/kryon-vm-oracle.key     # private key for opc@
```

---

## Phase 1 — Fund the operator wallets ⏱ 10 min

**Do this first, not last.** The oracle burns 1–3 XLM/day/market across 8
markets and is down to 9.79 XLM. If it runs dry mid-migration you will be
debugging an empty order book that has nothing to do with the migration.

| Account | Address | Now |
|---|---|---|
| oracle-publisher | `GCGMZDM57KMBLBGFTNZVNVIW2BBCDS5UXR6LN6OGQ4SVBJ3QKPPER2WO` | 9.21 |
| matcher-operator | `GCGPFN26NHKERBIEVOZN7SIFMB7T2TIWRMUQAQRWIOEKYPZL4D3O3AP3` | 3.65 |
| liquidator | `GA2GTULUA67G7AD5TVMGS3J5AXTQSREFQ43KZKZDIZNR7VCBMZEWKGON` | 2.99 |

🧑 Send **at least 100 XLM each** — roughly a month of runway at current burn.
Then verify:

```bash
for a in GCGMZDM57KMBLBGFTNZVNVIW2BBCDS5UXR6LN6OGQ4SVBJ3QKPPER2WO \
         GCGPFN26NHKERBIEVOZN7SIFMB7T2TIWRMUQAQRWIOEKYPZL4D3O3AP3 \
         GA2GTULUA67G7AD5TVMGS3J5AXTQSREFQ43KZKZDIZNR7VCBMZEWKGON; do
  echo -n "$a  "
  curl -s "https://horizon.stellar.org/accounts/$a" \
    | python3 -c 'import sys,json;print([b["balance"] for b in json.load(sys.stdin)["balances"] if b["asset_type"]=="native"][0])'
done
```

---

## Phase 1.5 — Get your working system into git ⏱ 30 min

**Verified 2026-08-23: `origin/main` does not contain the code your production
system is actually running.** Missing from the remote entirely:

| Missing from `origin/main` | Consequence if the VM deploys from it |
|---|---|
| `PUBLISH_TIME_BACKDATE_SECS` in `oracle-keeper.ts` | every oracle publish fails `Error(Contract, #6)` — the bug that silenced mainnet for 43 days |
| `client/lib/sql.ts` (the `pg` shim) | nothing can talk to the self-hosted Postgres at all |
| `client/features/network/*` | no network toggle, no degraded-venue banner |
| `client/ecosystem.testnet.config.cjs` | no testnet fleet to start in Phase 10 |

Plus 75 modified tracked files and 29 untracked ones on the laptop.

Phase 3 clones the repo onto the new box from `origin/main`, and CD does
`git reset --hard origin/main` on every deploy. **If you build the new box
today, you build it from code that cannot publish prices and cannot reach the
database.** The old box works only because it carries local edits that were
never pushed.

🧑 So, before Phase 2:

```bash
cd ~/Downloads/Kryon
git status --short                    # review — 104 files
git checkout -b main-sync             # or commit straight to main
git add -A && git commit -m "..."     # split into coherent commits if you can
git push origin HEAD
```

Then confirm the remote has what matters:

```bash
git show origin/main:client/scripts/oracle-keeper.ts | grep -c PUBLISH_TIME_BACKDATE_SECS   # want ≥1
git cat-file -e origin/main:client/lib/sql.ts && echo "sql shim present"
```

**Also check the old box** — it may carry edits that exist nowhere else:

```bash
ssh -i ~/.ssh/kryon-vm-oracle.key opc@92.4.91.30 'cd ~/kryon && git status --short'
```

Anything listed there is running in production and exists in no repository.
Copy it off before that instance is terminated in Phase 11.

---

## Phase 2 — Create the A1.Flex box ⏱ 15 min, or days if capacity is short

The 945 MB micro box **cannot** host the web tier — it is already at ~85% memory
with Postgres and 7 keepers, and `next build` alone will OOM it.

4 OCPU / 24 GB is the largest shape inside the Always Free *pool*, but your
tenancy's **service limit** is a separate cap: `ap-mumbai-1` is set to
**2 OCPU / 12 GB** (verified 2026-08-22, 0 in use), so a 4/24 launch fails with
`LimitExceeded`. 2/12 is ample here — ~1.7 GB for 14 Node processes, 3 GB of
Postgres shared buffers, ~7 GB spare — and `bootstrap.sh` scales its tuning to
whatever RAM it finds. Request a limit increase later from **Governance →
Limits, Quotas and Usage** if you want the headroom.

🧑 Authenticate (opens a browser):

```bash
~/.oci-cli-venv/bin/oci session authenticate --region <your-region> --profile-name kryon
```

🤖 Then create it:

```bash
cd ~/Downloads/Kryon/kryon-protocol/infra/a1flex
DRY_RUN=1 bash provision.sh     # discovery only — check the plan
OCPUS=2 MEMORY_GB=12 bash provision.sh   # sized to the service limit
```

It discovers your compartment, VCN, subnet and current Oracle Linux 9 Ampere
image rather than hardcoding OCIDs, and retries across every availability domain.

> **If it reports "Out of host capacity" in every AD:** that is Oracle's genuine
> free-tier Ampere shortage, not a config error. Either retry over the next few
> days, or upgrade the tenancy to **Pay As You Go** — Always Free resources stay
> free under PAYG and you get capacity priority. This is the same wall that
> blocked the A1 recreation in July.

**Save the printed IP.** It is `<NEW_IP>` everywhere below.

---

## Phase 3 — Bootstrap the box ⏱ 15 min

🤖

```bash
scp -i ~/.ssh/kryon-vm-oracle.key bootstrap.sh opc@<NEW_IP>:~/
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP> 'bash ~/bootstrap.sh'
```

Installs Node 22, PostgreSQL 16 tuned for 24 GB, pm2 with log rotation, creates
`kryon_mainnet` and `kryon_testnet`, opens the host firewall, enables nightly
`pg_dump` with 14-day retention and automatic security patching, and sets up pm2
boot persistence. Idempotent — safe to re-run.

🧑 **Save the database password it prints at the end.** It is also written to
`~/.kryon-db-password` and nowhere else.

Then get the repo and secrets onto the box:

```bash
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP> \
  'git clone --depth 1 https://github.com/Kryon-Protocol/Kryon.git ~/kryon'

# Operator secrets never live in git — copy the working env across.
scp -i ~/.ssh/kryon-vm-oracle.key \
    opc@92.4.91.30:~/kryon/client/.env.local /tmp/kryon-env
scp -i ~/.ssh/kryon-vm-oracle.key \
    /tmp/kryon-env opc@<NEW_IP>:~/kryon/client/.env.local
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP> 'chmod 600 ~/kryon/client/.env.local'
rm /tmp/kryon-env
```

---

## Phase 4 — Move the mainnet database ⏱ 10 min

🤖 **Run this on the NEW box:**

```bash
scp -i ~/.ssh/kryon-vm-oracle.key migrate-from-micro.sh opc@<NEW_IP>:~/
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP> \
    'bash ~/migrate-from-micro.sh 92.4.91.30'
```

It **stops the mainnet keepers on the old box first**, then dumps, restores and
verifies row counts across 6 tables, refusing to pass on a mismatch. That
ordering is not optional: a dump taken against a live fleet captures a torn
state, and — worse — two boxes running the same network's keepers means two
processes signing with the same Stellar keys, racing one sequence number into
`TxBadSeq` on both. That is what killed the laptop fleet in July.

Then start the mainnet fleet on the new box:

```bash
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP>
cd ~/kryon/client && npm ci
pm2 start ecosystem.config.cjs && pm2 save
pm2 status                       # 7 kryon-* online
pm2 logs kryon-oracle --lines 30 # fresh tx hashes within ~1 min
```

- [ ] 7 processes online
- [ ] oracle logging successful publishes (**not** `Error(Contract, #6)` — that
      is the `publish_time` staleness bug; `PUBLISH_TIME_BACKDATE_SECS` defaults
      to 15 and handles it, but check)

---

## Phase 5 — Move DNS to Cloudflare ⏱ 15 min + up to 24 h propagation

> **Detailed click-by-click walkthrough: [`PHASE-5-DNS.md`](./PHASE-5-DNS.md).**

Cloudflare Tunnel routes by hostname through `*.cfargotunnel.com` CNAMEs that
**only resolve on Cloudflare DNS**. Name.com cannot host them. The domain stays
registered at Name.com; only the nameservers change.

1. 🧑 Cloudflare → **Add a site** → `kryonprotocol.live` → **Free** plan.
2. 🧑 It imports the existing records. **Delete all three Vercel records:**
   `A @ → 216.198.79.1`, `A @ → 64.29.17.1`, `CNAME www → cname.vercel-dns.com`.
   The tunnel creates its own in Phase 8; leaving these means the edge races
   Vercel and serves the dead deployment. Verified 2026-08-22: the zone has no
   MX, TXT, CAA or AAAA records, so there is nothing else to preserve — no
   email or domain verification breaks when the nameservers move.
3. 🧑 Cloudflare shows two nameservers. In **Name.com → Domain → Nameservers**,
   replace all four `ns[1-4]*.name.com` with them.
4. Wait for the zone to read **Active**, then confirm:

```bash
dig +short NS kryonprotocol.live     # must return the two Cloudflare NS
```

**Do not continue until this returns Cloudflare nameservers.**

---

## Phase 6 — Configure the web tier ⏱ 10 min

🧑 On the new box, edit `~/kryon/client/.env.local`:

```bash
# Both networks, both loopback — this is the entire reason the app moved here.
# lib/db.ts refuses to cross-serve, so an unset testnet URL makes every testnet
# route throw rather than quietly returning mainnet rows.
DATABASE_URL_MAINNET=postgresql://kryon:<PW>@localhost:5432/kryon_mainnet?sslmode=disable
DATABASE_URL_TESTNET=postgresql://kryon:<PW>@localhost:5432/kryon_testnet?sslmode=disable

# Declare each venue honestly. Unset means "only the primary network is live",
# which is what made the banner call MAINNET dead while it was the only venue
# with keepers running.
NEXT_PUBLIC_MAINNET_KEEPERS_LIVE=true
NEXT_PUBLIC_TESTNET_KEEPERS_LIVE=false     # → true after Phase 10

NEXT_PUBLIC_WS_URL_MAINNET=wss://ws.kryonprotocol.live
NEXT_PUBLIC_WS_URL_TESTNET=wss://ws-testnet.kryonprotocol.live
NEXT_PUBLIC_WS_URL=                        # legacy single-network var: leave empty

NEXT_PUBLIC_STELLAR_NETWORK=mainnet
NEXT_PUBLIC_APP_URL=https://kryonprotocol.live   # an empty string crashes next build

ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...   # from Phase 0

# REQUIRED, not optional. lib/rate-limit.ts fails CLOSED under
# NODE_ENV=production: with no Upstash credentials it denies every request to
# /api/orders, /cancel, /settlements, /fills, /funding and /portfolio. Because
# /api/ready does not rate-limit, the site comes up green and then rejects
# every order. Reuse the existing free-tier database
# (https://concise-impala-100570.upstash.io) — but rotate the token first, it
# was pasted into a chat transcript.
UPSTASH_REDIS_REST_URL=https://concise-impala-100570.upstash.io
UPSTASH_REDIS_REST_TOKEN=...
```

> **Do not wrap values in double quotes.** A quoted `DATABASE_URL` once broke
> every database route with `readiness_unavailable` on the Workers deploy.

Verify both databases answer before building:

```bash
# Table names are Prisma model names — PascalCase and quoted. Unquoted or
# lowercase `markets` errors with "relation does not exist".
psql "postgresql://kryon:<PW>@localhost:5432/kryon_mainnet" -c 'SELECT count(*) FROM "Market";'
psql "postgresql://kryon:<PW>@localhost:5432/kryon_testnet" -c 'SELECT count(*) FROM "Market";'
```

---

## Phase 7 — Create the tunnel ⏱ 10 min

🧑 On the new box:

```bash
sudo dnf install -y https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.rpm
cloudflared tunnel login          # prints a URL — open it, authorise kryonprotocol.live
cloudflared tunnel create kryon   # prints the TUNNEL-ID and credentials path
```

Install the ingress config:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/kryon/kryon-protocol/infra/a1flex/cloudflared-config.yml /etc/cloudflared/config.yml
sudo sed -i "s/<TUNNEL-ID>/<the-id-just-printed>/g" /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
sudo cloudflared --config /etc/cloudflared/config.yml validate
```

The tunnel dials **outbound**, so nothing needs an inbound hole: no VCN Security
List ingress rule, no public 5432, no public 3000. That also retires the
8080/8081 ingress rules §2 of `README.md` asks for — their absence is why the
ws-server has been externally unreachable since July.

---

## Phase 8 — Build and go live ⏱ 15 min

🤖

```bash
bash ~/kryon/kryon-protocol/infra/a1flex/setup-web-tier.sh
```

Preflights the database config (refuses to build without it), builds the app and
the Docusaurus `/docs` export, installs cloudflared as a systemd service, points
all four hostnames at the tunnel, starts `kryon-web` under pm2, asserts the app
is bound to loopback only, and verifies `/api/ready` on both networks.

---

## Phase 9 — Verify ⏱ 10 min

```bash
curl -s https://kryonprotocol.live/api/ready | python3 -m json.tool
curl -s 'https://kryonprotocol.live/api/ready?network=testnet' | python3 -m json.tool
curl -s https://kryonprotocol.live/api/markets/BTC-PERP | python3 -m json.tool
```

- [ ] `/api/ready` is `ok:true` on **both** networks
- [ ] `BTC-PERP` mark price is fresh — a timestamp more than a few minutes old
      means the oracle keeper is down, not the web tier
- [ ] `/trade/BTC-PERP` renders an order book, **no degraded banner on mainnet**
- [ ] devtools → Network → WS shows `wss://ws.kryonprotocol.live` **connected**,
      not falling back to REST polling
- [ ] `/docs` loads
- [ ] place a small limit order end to end and see it appear in the book

---

## Phase 10 — Bring testnet up ⏱ 30 min

This is what legitimately removes the testnet banner. It is currently telling
the truth: `ecosystem.testnet.config.cjs` exists but has never been started.

🧑 Fund **three new testnet accounts** at https://friendbot.stellar.org —
oracle publisher, matcher operator, liquidator. **Never reuse the mainnet
operator keys.** Both fleets now share one host, so a reused key means two
processes racing one sequence number → `TxBadSeq` on both.

```bash
cd ~/kryon/client
cp .env.testnet.example .env.testnet    # fill in the three secrets + DB URL
# NOT `npm run db:seed-markets` — that script hardcodes --env-file=.env.local
# and would seed the MAINNET database.
npx tsx --env-file=.env.testnet scripts/seed-markets.ts
pm2 start ecosystem.testnet.config.cjs && pm2 save
pm2 status                               # 7 more kryon-testnet-* online
```

Then flip the flag and rebuild — it is inlined into the client bundle at build
time, so a restart alone will not pick it up:

```bash
sed -i 's/NEXT_PUBLIC_TESTNET_KEEPERS_LIVE=false/NEXT_PUBLIC_TESTNET_KEEPERS_LIVE=true/' .env.local
bash ~/kryon/kryon-protocol/infra/a1flex/setup-web-tier.sh
```

---

## Phase 11 — Decommission and rotate ⏱ 20 min

Only after Phase 9 passes. Two deployments answering for Kryon, one permanently
503, is worse than one.

- [ ] 🧑 Vercel → project → Settings → **Delete** (or at least remove the
      `kryonprotocol.live` domain assignment)
- [ ] 🧑 `npx wrangler delete kryon-client`
- [ ] 🧑 Add `VM_HOST`, `VM_USER`, `VM_SSH_KEY`, `VM_HOST_KEY` to the GitHub
      `production` environment so `deploy-production.yml` deploys to the VM.
      Until they exist the deploy job skips cleanly.
- [ ] 🧑 **Rotate the credentials that were pasted into chat transcripts:** the
      Cloudflare API token and the Upstash REST token.
- [ ] 🧑 Terminate the micro instance `92.4.91.30` — **last**, and only once the
      new box has been serving for a day.

---

## Phase 12 — Ongoing

**Redeploy** — push to `main` and CI does it, or by hand:

```bash
cd ~/kryon && git pull
bash kryon-protocol/infra/a1flex/setup-web-tier.sh
```

A failed build leaves the previous bundle serving; `next start` never compiles.

**Watch:**

```bash
pm2 status                       # 14 processes once both fleets run
pm2 logs kryon-web
journalctl -u cloudflared -f
```

**Rollback** — the tunnel is the only thing between the browser and the box:

```bash
sudo systemctl stop cloudflared   # site dark, keepers unaffected
```

Nothing about the keepers or the database depends on the web tier. A bad deploy
costs the site, never protocol state.

---

## If something breaks

| Symptom | Cause |
|---|---|
| `503 readiness_unavailable` | `DATABASE_URL_*` unset, or wrapped in double quotes |
| Testnet routes 500, mainnet fine | `DATABASE_URL_TESTNET` unset — it will not fall back to mainnet by design |
| Banner says a live venue is dead | `NEXT_PUBLIC_*_KEEPERS_LIVE` unset; falls back to "only the primary network is live" |
| Flag changed but UI unchanged | `NEXT_PUBLIC_*` is inlined at build time — rebuild, don't restart |
| Oracle `Error(Contract, #6)` | `publish_time` ahead of the last closed ledger — raise `PUBLISH_TIME_BACKDATE_SECS` |
| `TxBadSeq` on both fleets | Two processes sharing one Stellar key. Six distinct funded accounts, three per network |
| WS falls back to REST | `cloudflared` down, or `NEXT_PUBLIC_WS_URL_*` unset at build time |
| `next build` OOMs | You are on the micro box. It cannot host the web tier |
| "Out of host capacity" | Free-tier Ampere shortage — retry, or upgrade to PAYG |
