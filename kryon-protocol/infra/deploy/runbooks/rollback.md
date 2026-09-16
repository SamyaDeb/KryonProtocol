# Rollback Runbook

## Client app rollback (Vercel)

```bash
# List recent deployments
vercel ls --scope samyadebs-projects

# Promote a previous deployment to production
vercel promote <deployment-url> --scope samyadebs-projects
```

The previous deployment becomes active in ~30s. No data loss.

## Service rollback (Railway)

1. Open Railway dashboard → project → service
2. Click Deployments tab
3. Find the last known-good deployment
4. Click "Redeploy" on that deployment

Or via CLI:
```bash
# List deployments for a service
railway list deployments --service <service-name>

# Roll back by redeploying a previous commit
git checkout <previous-sha>
cd client && railway up --service oracle-keeper --detach
```

## Contract rollback

Contracts on Soroban are immutable once deployed — you cannot "roll back" a contract.  
Instead, deploy a fresh instance and update the env vars to point to the new address.

**Decision tree:**
- Bug in oracle adapter → run `ORACLE_PUBLISHER_SECRET=... npx tsx scripts/redeploy-oracle.ts`
- Bug in vault/engine/gateway → run `ORACLE_PUBLISHER_SECRET=... npx tsx scripts/redeploy-core.ts`
- Both scripts patch config files and print new contract IDs automatically.

After redeployment:
1. Update `.env.local` with new contract IDs
2. Update Vercel env vars (see deploy step in main launch doc)
3. Redeploy Vercel: `vercel --yes --prod --scope samyadebs-projects`
4. Restart all services with new env

**Note:** Users with open positions in the old vault must close before migration. Coordinate a maintenance window.

## DB schema rollback

Prisma does not support automatic schema rollback. To undo a migration:

1. Identify the bad migration in `kryon-protocol/prisma/migrations/`
2. Write and run a manual SQL reversal on Neon
3. Mark the migration as rolled back in Prisma's `_prisma_migrations` table:
   ```sql
   UPDATE "_prisma_migrations" SET rolled_back_at = NOW() WHERE migration_name = '<name>';
   ```
4. Delete the migration folder from the repo
5. Run `prisma migrate deploy` to re-sync

## Environment variable rollback

All env vars are versioned in Vercel. To restore a previous value:

```bash
vercel env ls --scope samyadebs-projects      # see current values
vercel env rm KEY production                  # remove current
echo "old-value" | vercel env add KEY production  # restore old
```
