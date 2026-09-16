# Phase 5 — Move `kryonprotocol.live` DNS to Cloudflare

Detailed walkthrough. ⏱ ~15 minutes of clicking, then anywhere from 10 minutes
to 24 hours of nameserver propagation.

**The domain stays registered at Name.com.** Only the nameservers change, so
Cloudflare answers DNS queries instead of Name.com. Nothing is transferred, no
fee, and it is reversible by putting the old nameservers back.

---

## Why this is required

Cloudflare Tunnel publishes each hostname as a CNAME to
`<tunnel-id>.cfargotunnel.com`. That target only resolves inside Cloudflare's
own DNS — it is not a public record. Name.com cannot host it, and there is no
workaround: a tunnel with no Cloudflare zone has no way to be reached by name.

---

## What your zone looks like right now

Verified 2026-08-22:

| Type | Name | Value | |
|---|---|---|---|
| A | `@` | `216.198.79.1` | Vercel — delete |
| A | `@` | `64.29.17.1` | Vercel — delete |
| CNAME | `www` | `cname.vercel-dns.com` | Vercel — delete |
| NS | `@` | `ns1psw` / `ns2dhj` / `ns3dty` / `ns4hmp .name.com` | replaced in step D |

**There is nothing else.** No MX, no TXT, no CAA, no AAAA, no other subdomains.
So this move cannot break email, domain verification, or a certificate
authority restriction — you have none of those. **DNSSEC is not enabled** (no DS
or DNSKEY at the registry), which is the one thing that would otherwise make a
nameserver change break resolution outright.

You can re-verify any time with:

```bash
dig +short NS kryonprotocol.live
dig +short A  kryonprotocol.live
dig +short MX kryonprotocol.live      # expect empty
dig +short DS kryonprotocol.live      # expect empty = no DNSSEC
```

---

## Step A — Add the site to Cloudflare ⏱ 3 min

1. Log in at <https://dash.cloudflare.com> as **sammodeb28@gmail.com**
   (account `b8a23edf0ffbfe1137d1d672b0017238` — the one that already owns the
   `kryon-client` Worker).
2. Top of the dashboard → **Add a domain** (older UI: **Add site**).
3. Type `kryonprotocol.live` — **no `www`, no `https://`**.
4. Choose **Continue with Free**. Nothing here needs a paid plan: tunnels,
   unlimited DNS records and universal SSL are all on Free.
5. Cloudflare scans the existing zone and shows what it found.

---

## Step B — Clean up the imported records ⏱ 2 min

Cloudflare will have imported the three Vercel records. **Delete all three:**

- `A` `kryonprotocol.live` → `216.198.79.1`
- `A` `kryonprotocol.live` → `64.29.17.1`
- `CNAME` `www` → `cname.vercel-dns.com`

Click **Delete** on each row, then **Continue**.

> **Why delete rather than leave them:** Phase 8 creates the tunnel's own
> records for `@`, `www`, `ws` and `ws-testnet`. If the Vercel records are still
> there, the apex has two conflicting answers and the edge will happily serve
> the dead Vercel deployment for some fraction of requests — an intermittent
> 503 that looks like a tunnel bug and is not.

**Leave the record list empty.** An empty zone is correct at this stage; the
tunnel populates it in Phase 8. The domain will not resolve between now and
then — which costs nothing, since it currently serves a 503 anyway.

---

## Step C — Copy your assigned nameservers ⏱ 1 min

Cloudflare assigned this account:

```
celine.ns.cloudflare.com
scott.ns.cloudflare.com
```

Both verified resolving 2026-08-22. These two, exactly — no others, and not four.

---

## Step D — Replace the nameservers at Name.com ⏱ 5 min

1. Log in at <https://www.name.com>.
   ⚠️ **This is the account whose registrant email is a different Gmail** —
   the mismatch behind the 2026-08-16 ICANN suspension notice. If you cannot get
   in, stop here and recover that account first; every remaining phase depends
   on this step.
2. **My Domains** → click `kryonprotocol.live`.
3. Find **Nameservers** in the left sidebar (or the "Manage Nameservers" link on
   the domain overview).
4. You will see the four `ns[1-4]*.name.com` entries. **Delete all four** and
   add exactly these two:

   ```
   celine.ns.cloudflare.com
   scott.ns.cloudflare.com
   ```

   Two is correct — do not pad the list back out to four.
5. **Save / Apply Changes.**

> **If Name.com refuses the change:** look for a **Domain Lock** (also called
> registrar lock or `clientTransferProhibited`) on the domain settings page and
> turn it off, make the change, then turn it back on. A lock blocks nameserver
> edits at some registrars.

---

## Step E — Wait, then verify ⏱ 10 min – 24 h

Cloudflare emails you when the zone goes **Active**. Verify yourself:

```bash
# The authoritative check — must return your two Cloudflare nameservers.
dig +short NS kryonprotocol.live

# Ask the registry directly, bypassing any cached answer on your machine.
dig +norecurse NS kryonprotocol.live @v0n0.nic.live
```

The registry answer flips within minutes; resolvers worldwide catch up over the
TTL (this zone's SOA says 3600 s, so allow an hour, and up to 24 to be safe).

- [ ] `dig +short NS kryonprotocol.live` returns `*.ns.cloudflare.com`
- [ ] The Cloudflare dashboard shows the zone as **Active**, not "Pending
      Nameserver Update"

**Do not start Phase 7 until both are true.** `cloudflared tunnel login` lists
the zones on your account and will not offer `kryonprotocol.live` until the zone
is Active.

---

## Step F — Two settings to set once the zone is Active ⏱ 2 min

In the Cloudflare dashboard for the zone:

1. **SSL/TLS → Overview → Full (strict)**.
   The default on some accounts is *Flexible*, which terminates TLS at the edge
   and talks plain HTTP to the origin. With a tunnel that is both unnecessary
   and misleading about the actual security posture. Full (strict) is correct:
   cloudflared's connection to the edge is already authenticated and encrypted.
2. **SSL/TLS → Edge Certificates → Always Use HTTPS: On.**

Leave everything else at defaults. In particular, **do not create any DNS
records by hand** — `setup-web-tier.sh` creates all four in Phase 8, already
proxied, and a manually created record with the wrong proxy state will collide
with it.

---

## Rollback

If you need to undo this before the tunnel is up, put the four Name.com
nameservers back:

```
ns1psw.name.com    ns2dhj.name.com    ns3dty.name.com    ns4hmp.name.com
```

and re-create the two `A` records and the `www` CNAME from the table at the top.
Nothing is lost — the domain never leaves Name.com's registration.

---

## When you're done

Tell me `dig +short NS kryonprotocol.live` returns Cloudflare, and I can drive
Phases 6–11 from here (I need a Bash permission rule for `ssh` — it is currently
blocked by the auto-mode classifier).
