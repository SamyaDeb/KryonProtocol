# A1.Flex — production host for the mainnet + testnet keeper fleets

Replaces the `VM.Standard.E2.1.Micro` (945 MB) that currently runs the mainnet
fleet at ~85% memory plus swap, and gives the testnet fleet a home.

---

> **Start here:** [`GO-LIVE.md`](./GO-LIVE.md) is the ordered end-to-end path
> (fund wallets → create box → migrate → DNS → tunnel → verify). This file and
> `WEB-TIER.md` hold the reasoning behind individual phases.
>
> **Web tier:** the Next.js app now runs on this box too, behind a Cloudflare
> Tunnel — see [`WEB-TIER.md`](./WEB-TIER.md). That supersedes the Vercel and
> Cloudflare Workers deployments, and makes the §2 VCN ingress rules for
> 8080/8081 unnecessary (the tunnel dials outbound).


## 1. Is it actually free?

Yes, permanently — but the shape matters. Oracle's **Always Free** tier grants
Ampere A1 compute as a monthly *pool*, not as an instance size:

| Always Free allowance | Per month |
|---|---|
| Ampere A1 OCPU hours | 3,000 |
| Ampere A1 memory | 18,000 GB-hours |
| Block/boot storage | 200 GB total |

A **4 OCPU / 24 GB** instance running continuously costs:

```
4 OCPU  × 730 h = 2,920 OCPU-hours   ≤ 3,000   ✓
24 GB   × 730 h = 17,520 GB-hours    ≤ 18,000  ✓
```

So 4/24 running 24/7 fits inside Always Free with roughly 3% headroom, and is
the largest shape that does. **Do not exceed 4 OCPU or 24 GB** — going over
converts the whole instance to paid, billed hourly.

> **⚠️ The monthly pool is not your service limit.** Verified on this tenancy
> 2026-08-22: A1 limits in `ap-mumbai-1` are **2 OCPU / 12 GB**, 0 in use — so a
> 4/24 launch fails `LimitExceeded` (`standard-a1-core-count`,
> `standard-a1-memory-count`) even though the Always Free *pool* would cover it.
> Check before planning around a shape:
>
> ```bash
> oci limits resource-availability get --compartment-id <tenancy> \
>   --service-name compute --limit-name standard-a1-core-count \
>   --availability-domain <AD>
> ```
>
> Raise it from **Governance → Limits, Quotas and Usage → Request increase**
> (free, not instant). 2/12 is ample regardless: ~1.7 GB for 14 Node processes,
> 3 GB Postgres shared buffers, ~7 GB spare. `bootstrap.sh` scales its tuning to
> whatever RAM it finds, so a smaller shape needs no config change.
>
> Repeated failed launches also trip a **429 `TooManyRequests`** cooldown on the
> user — back off a minute or two between attempts rather than retrying tightly.

Two caveats that are not obvious:

- **Capacity.** Free-tier Ampere is frequently unavailable ("Out of host
  capacity") in busy regions. It is a genuine shortage, not a quota error.
  Retry across availability domains, or upgrade the tenancy to **Pay As You
  Go** — Always Free resources stay free under PAYG, but you get capacity
  priority. This is the same wall that blocked the A1 recreation in July.
- **Idle reclamation.** Oracle reclaims Always Free *compute* idle for 7 days
  (under 20% CPU, low network). The keepers poll constantly, so this fleet will
  never qualify — but do not park a spare A1 for later expecting it to survive.

Storage: the 200 GB pool covers the boot volume. 100 GB is plenty here and
leaves room for a second instance.

---

## 2. Console steps (you must do these — they need an interactive login)

1. **Compute → Instances → Create instance.**
2. **Image:** Oracle Linux 9 — matches the existing box, so every runbook,
   `dnf` command and `firewalld` rule carries over unchanged.
3. **Shape:** `VM.Standard.A1.Flex`, **4 OCPUs, 24 GB**.
4. **Networking:** the existing VCN is fine. Assign a public IPv4.
5. **SSH key:** upload `~/.ssh/kryon-vm.pub` so your existing key works.
6. **Boot volume:** 100 GB.
7. Create, then note the public IP.

### Then open the WebSocket ports — do not skip this

The current box has `firewalld` open on 8080 but the **VCN Security List
ingress rule was never added**, which is why the mainnet ws-server has been
unreachable externally since July and the UI has been falling back to REST
polling. Add it now for both fleets:

**Networking → VCN → Security Lists → Default → Add Ingress Rules:**

| Source | Protocol | Dest. port | Purpose |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 8080 | mainnet ws-server |
| `0.0.0.0/0` | TCP | 8081 | testnet ws-server |

`bootstrap.sh` opens the host firewall for both, but the VCN rule is a separate
layer and only the console can add it.

---

## 3. Bootstrap

```bash
scp -i ~/.ssh/kryon-vm-oracle.key \
    kryon-protocol/infra/a1flex/bootstrap.sh opc@<NEW_IP>:~/
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP> 'bash ~/bootstrap.sh'
```

Idempotent — safe to re-run. It installs Node 22, PostgreSQL 16, pm2 with log
rotation, creates both databases, tunes Postgres for 24 GB, opens the host
firewall, enables nightly backups and automatic security patching, and sets up
boot persistence.

It prints the generated database password once at the end. **Save it** — it
goes into both `.env` files and is not stored anywhere else.

---

## 4. Migrate mainnet off the micro box

```bash
scp -i ~/.ssh/kryon-vm-oracle.key \
    kryon-protocol/infra/a1flex/migrate-from-micro.sh opc@<NEW_IP>:~/
ssh -i ~/.ssh/kryon-vm-oracle.key opc@<NEW_IP> \
    'bash ~/migrate-from-micro.sh 92.4.91.30'
```

The script **stops the mainnet keepers on the old box first**, then dumps and
restores. That ordering is deliberate and not optional: the indexer and matcher
write continuously, so a dump taken against a live fleet captures a torn state
— and worse, running both fleets at once means two processes signing with the
same Stellar keys, which collides on sequence numbers and produces `TxBadSeq`
on both. Never have both boxes running the same network's keepers.

---

## 5. Cutover checklist

- [ ] `pm2 status` on the new box shows 7 `kryon-*` online
- [ ] `psql -c 'SELECT count(*) FROM "Fill"'` matches the old box
- [ ] Oracle publishing: `pm2 logs kryon-oracle` shows fresh tx hashes
- [ ] `curl http://<NEW_IP>:8080` reachable **from your laptop** (proves the VCN rule)
- [ ] `ALERT_WEBHOOK_URL` is set — see §6
- [ ] Point `NEXT_PUBLIC_WS_URL_MAINNET` / `_TESTNET` at the new IP, redeploy client
- [ ] Only then: terminate the old micro instance

---

## 6. Set ALERT_WEBHOOK_URL before you call this production

It is still unset. That single gap is why the 2026-07 mainnet outage ran
**43 days** unnoticed: the monitor detected the failure correctly every cycle
and had nowhere to send it. A Discord webhook URL works as-is in both
`.env.local` and `.env.testnet`.

---

## 7. Operating two fleets

```bash
pm2 start ecosystem.config.cjs           # mainnet  → kryon-*
pm2 start ecosystem.testnet.config.cjs   # testnet  → kryon-testnet-*
pm2 save

pm2 restart /kryon-testnet-/             # testnet only
pm2 restart /^kryon-(?!testnet)/         # mainnet only
```

Memory budget on 24 GB: 14 Node processes at ~120 MB ≈ 1.7 GB, Postgres
`shared_buffers` 6 GB, leaving ~15 GB free. The `max_memory_restart` recycling
that the micro box suffered will not occur.

**Operator keys must never be shared between the two fleets.** Both fleets run
on one host now, so a reused key means two processes racing one account's
sequence number — the exact `TxBadSeq` failure that forced the laptop fleet to
be shut down in July. Three distinct funded accounts per network, six total.
