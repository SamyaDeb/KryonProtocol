# Service key rotation (Arc)

Planned rotation of any service key, and emergency revocation of a leaked one.
Read [`../../signers/README.md`](../../signers/README.md) first: it describes
where keys live (`KRYON_SIGNER_<ROLE>`) and why each key serves one role.

**One key serves exactly one role, in exactly one process.** `TxSender` owns
its key's nonce, so two processes that share a key strand each other's
transactions, and a key that holds two roles has to be rotated for both at
once. Never reuse an old key for a new role.

## Inventory

Who can grant each role comes from the contracts, not from convention. No proxy
calls `_setRoleAdmin`, so every service role's admin is `DEFAULT_ADMIN_ROLE`.
After `05_Handover`, the timelock is the only holder of `DEFAULT_ADMIN_ROLE`
(`99_VerifyDeployment` and the monitor both check this). Every grant and
revoke therefore goes through a **48h timelock proposal**. There is no faster
direct grant. The exceptions are the keys that hold no role at all.

| Service (`KRYON_SIGNER_<ROLE>`) | On-chain role | Contract | Granted by | Custody (mainnet) |
| --- | --- | --- | --- | --- |
| matcher (`MATCHER_OPERATOR`) | `OPERATOR_ROLE` | OrderGateway | timelock `grantRole` (48h) | KMS, one key per shard |
| oracle-keeper (`ORACLE_PUBLISHER`) | `PUBLISHER_ROLE` | OracleAdapter | timelock `setPublishers([...])` (RISK_ADMIN, 48h). Replaces the **whole** set | KMS, one key per publisher host |
| funding-keeper (`FUNDING_KEEPER`) | `KEEPER_ROLE` | Engine | timelock `grantRole` (48h) | KMS |
| liquidation-keeper (`LIQUIDATOR`) | none. `liquidate()` is permissionless | — | nothing to grant | KMS (holds gas only) |
| keeper-refill (`REFILL_FUNDER`) | none | — | nothing to grant | KMS (holds the gas float) |
| fee-tier-bot (`FEE_TIER_BOT`) | `FEE_TIER_ROLE` | FeeRouter | timelock `grantRole` (48h) | KMS |
| backstop-unwinder (`BACKSTOP_SIGNER`) | `BACKSTOP_SIGNER_ROLE` | Insurance | timelock `grantRole` (48h). Not granted at deploy | KMS. Signs orders only, sends no transactions |
| guardian | `PAUSER_ROLE` (proxies + timelock) | all | timelock | Safe (N-of-M), not a service |
| governance | timelock proposer/canceller | KryonTimelock | timelock | Safe (N-of-M), not a service |

Notes that matter during a rotation:

- **`setPublishers` replaces the whole list** and revokes `PUBLISHER_ROLE` from
  every old entry in the same call. Do not use `grantRole(PUBLISHER_ROLE, …)`
  directly: the aggregation only iterates the list, so a key granted outside
  it never counts toward the quorum. Mainnet runs `min_publishers = 2`, so keep
  **at least 3 publishers** so that one can be rotated or revoked without
  losing quorum.
- A rotated **liquidator** or **refill funder** needs no governance at all. For
  the refill funder, move the float to the new key (see step 5).
- The **backstop signer** has no nonce and no gas. Orders it signed stay valid
  until their `expiry` (at most 1h, `MAX_UNWIND_ORDER_TTL`) and only while
  that key still holds the role: `Insurance.isValidSignature` checks
  `hasRole` at fill time. Revoking the role cancels all of that key's
  outstanding orders at once.
- `renounceRole(role, self)` is always open to the holder. It is the fastest
  way to remove a key you still control (see Emergency).

## Creating the new key

Mainnet and testnet use `kms` (see `../../signers/README.md`):

```bash
aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY \
  --description "kryon <network> <role> $(date -u +%F)"
aws kms create-alias --alias-name alias/kryon-<network>-<role>-<yyyymmdd> --target-key-id <keyId>
```

Grant the service's runtime identity (task role or instance profile) only
`kms:GetPublicKey` and `kms:Sign` on that one key. Read the new address
without signing anything:

```bash
cd client
KRYON_NETWORK=<network> KRYON_SIGNER_<ROLE>=kms:<alias> \
  npx tsx scripts/signer-address.ts <ROLE key variable, e.g. LIQUIDATOR_PRIVATE_KEY>
```

A `keystore` key (where KMS is not available) is created with
`cast wallet new <dir>` and stored in the secret manager together with its
passphrase. The passphrase is mounted as a file
(`KRYON_KEYSTORE_<ROLE>_PASSPHRASE_FILE`).

Record the new address in the rotation ticket. Fund it with gas
(`keeper-refill` does this once the address is in `REFILL_TARGETS`) **before**
it takes traffic. The backstop signer needs no gas.

## Planned rotation, per role

Run the steps in order. Old and new keys overlap between steps 2 and 5, and
that overlap is intended: the old key keeps serving until the new one is
proven.

1. **Create** the new key (above), fund it, and add it to the monitor's gas
   targets.
2. **Grant** the role to the new key through the timelock (48h):
   - `OPERATOR_ROLE` / `KEEPER_ROLE` / `FEE_TIER_ROLE` / `BACKSTOP_SIGNER_ROLE`:
     `grantRole(role, new)` on the owning proxy.
   - `PUBLISHER_ROLE`: `setPublishers([...current, new])` on OracleAdapter
     (≤ 5 total). The old key is removed in step 5.
   - liquidator / refill funder: skip, no role.

   Schedule and execute as described in [`timelock-operations.md`](timelock-operations.md).
   **Update the role baseline in the same change**: the grant pages
   `governance.roles` until `roles.<network>.json` includes the new key.
3. **Drain in-flight work on the old key.** Stop the service
   (`pm2 stop kryon-<service>` / `docker compose stop <service>`). The
   reconciler keeps rebroadcasting the old key's open jobs and records their
   receipts. It needs no key for that. Proceed only when `TxJob` has no open
   rows for the old address:

   ```sql
   SELECT count(*) FROM "TxJob"
    WHERE lower("fromAddress") = lower('<old>') AND status IN ('PENDING','SUBMITTED');
   ```

   If the reconciler reports a job stuck past the replacement window, it
   needs a fee bump, and only the old key can sign that. Start the old
   configuration once more. `recoverOpenJobs` runs before any new work, so
   stop the service again as soon as it logs `startup recovery complete` with
   `unresolved: 0`. Then re-check the count.
   For the backstop signer, instead wait until the old key's unwind orders
   have expired or filled (≤ 1h).
4. **Switch the service.** Set `KRYON_SIGNER_<ROLE>=kms:<new alias>`, restart,
   and confirm the startup log line `signer loaded` names the new address and that its first
   transaction lands (or, for the backstop, that its first order is accepted
   by `POST /api/orders`).
5. **Revoke the old key:**
   - role-holding keys: timelock `revokeRole(role, old)`, or the faster path,
     `renounceRole(role, old)` sent from the old key itself (no timelock needed,
     and it cannot be reversed). For publishers, `setPublishers` without the old key.
   - refill funder: move the remaining float to the new funder, leaving the
     old key's gas for this transfer.
   - Every old key: schedule it for deletion in KMS
     (`aws kms schedule-key-deletion --pending-window-in-days 30`). Keep it
     disabled, not deleted, until the window ends.
6. **Confirm in the monitor.** `governance.roles` must be green with the new
   baseline (`npx tsx scripts/monitor.ts --print-role-baseline`, then diff it
   against the committed `roles.<network>.json`). `gas.balance` must show the
   new address. No `TxJob` row may be left open for the old one.

## Emergency: a key is leaked or suspected

The 48h timelock is too slow to revoke with, so contain first:

1. **Renounce from the key itself** if we still control it:
   `renounceRole(<role>, <leaked>)` signed by the leaked key. It takes effect
   in the next block, needs no governance, and the attacker cannot undo it.
   Do the same for every role that key holds. It should hold only one.
2. **Pause** if the role can do damage before step 1 lands, or if we no
   longer control the key. The guardian calls `pause()` on the affected proxy
   (OrderGateway for the operator, OracleAdapter for a publisher, Engine for
   the funding keeper) for 72h. Schedule `pauseIndefinitely()` within 24h if
   more time is needed. See [`timelock-operations.md`](timelock-operations.md).
   - A leaked **operator** can only settle orders that users actually signed.
     The damage is ordering and front-running within signed limits. Pause the
     gateway.
   - A leaked **publisher** is one vote in a quorum median with spread and jump
     guards. Pause the oracle if the other publishers can't outvote it.
   - A leaked **backstop signer** can post reduce-only orders for the backstop,
     but only within `maxUnwindDeviationBps` of the index and the per-fill and
     daily caps. Renouncing the key cancels all its orders.
   - A leaked **fee-tier bot** key can only assign already-defined tiers. The
     exposure is fee revenue.
   - A leaked **liquidator** or **refill funder** key has no role. Drain what it
     holds to a safe key and stop the service.
3. **Queue the permanent fix** through the timelock (`revokeRole`,
   `setPublishers`) and grant a new key (planned steps 1, 2 and 4).
4. **Keep KMS audit evidence.** Disable the key (`aws kms disable-key`) rather
   than deleting it, and pull the CloudTrail `Sign` events for the incident
   record. Write it up per [`incident.md`](incident.md).
