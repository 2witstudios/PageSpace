# Personal billing cutover (D-OW-42)

The final application supports personal Free/Pro and organization Business. A
retired price never establishes paid entitlement. Complete subscriber verification
before applying migrations 0338–0339 or starting the final application.

## Verify the destination

1. Inventory every personal Stripe customer and subscription. Arrange any subscriber
   price change or cancellation explicitly in Stripe, including its billing and
   proration terms. A scheduled future change is not a completed migration.
2. Deliver the resulting webhooks and reconcile the local subscription mirrors.
3. For each personal Business or grandfathered account, record the chosen personal
   destination in a local manifest. The verifier accepts only version 1, unique
   user IDs, and Free/Pro destinations:

   ```json
   {
     "version": 1,
     "users": [
       { "userId": "actual-user-id", "tier": "pro" }
     ]
   }
   ```

   Pro requires the configured Pro price and matching active/trialing evidence.
   Free requires all personal subscriptions to have ended. An organization is a
   separate, explicit checkout; this script does not create or purchase one.
4. Run the verifier from the candidate checkout, using the target database and
   Stripe mode/credentials already configured in the environment:

   ```sh
   bun scripts/migrate-founder-to-pro.ts --dry-run --business-manifest /secure/path/destinations.json
   ```

   Without Business accounts, omit the manifest option. Dry-run writes nothing.
   Every unresolved customer, unknown live price, missing mirror, incomplete
   Stripe inventory, future schedule, or manifest mismatch blocks **all** writes.
   Do not proceed unless the command exits successfully with `ready: true`.

## Apply in the cutover maintenance window

Stop application traffic, background billing jobs and webhook deliveries during
the database cutover. This is a coordinated cutover: old application images must
not run against the schema after the grandfathering column is removed. Keep the
normal database backup and preserve the verified manifest and command output with
the deployment evidence.

```sh
bun scripts/migrate-founder-to-pro.ts --apply --business-manifest /secure/path/destinations.json
BILLING_CUTOVER_OFFLINE=true bun run db:migrate
bun scripts/migrate-founder-to-pro.ts --dry-run --business-manifest /secure/path/destinations.json
```

Apply re-reads Stripe and compares locked local user/subscription rows with the
observed evidence before writing. Any local change aborts the whole transaction.
It normalizes personal tier caches and clears the obsolete flag. It makes no
Stripe writes and changes no wallet balances or ledger records; existing credit
value remains spendable. Repeating it after success is a no-op.

Migration 0338 refuses retired personal tiers or uncleared flags. Migration 0339
then removes the flag. The retained database constraint prevents a runtime writer
from putting Founder or Business back in a personal row. Both migrations are
generated from the schema; never bypass their checks to complete deployment.

The same offline window applies two wallet-ledger migrations (WAL-5, WAL-6b):
0344 adds `credit_ledger.fallbackFromWalletId` with a foreign key to `wallets`,
whose validation takes a lock on the ledger while it scans; 0345 writes one
`opening_balance` ledger row per wallet (its balance less what its earlier rows
already account for), so balance-drift reconciliation is exact from the cutover
forward. Both run with traffic and billing jobs stopped; 0345 is idempotent
(keyed on `opening-balance:<walletId>`), so a repeated run writes nothing.

Start only the final application images, resume webhook delivery and jobs, and
verify personal Free/Pro plus organization billing through their respective
surfaces. This runbook does not replace the whole-epic activation checks in the
PageSpace cutover and operations runbook.

## Billing-disabled deployments

With `DEPLOYMENT_MODE=onprem` or `tenant`, run the same script without a manifest
or Stripe credentials. It normalizes synthetic retired personal tiers to Free
only when there is no Stripe customer or subscription evidence. Any such evidence
blocks apply and must be investigated through the billing-enabled verification
path. Deployment storage and tenant sandbox capabilities are resolved separately
from personal subscriptions.

## Evidence

The migration tests use a private pre-cutover PostgreSQL schema. They verify
dry-run, idempotency before and after column removal, stale mirror/flag rejection,
manifest refusal, schema guards, and unchanged wallet/ledger rows and spendable
credit value. Fresh-database and upgrade migration runs must also pass for the
exact deployment candidate.

## Automated Fly deployment gate

The migration entrypoint refuses an existing schema with the retired column unless
`BILLING_CUTOVER_OFFLINE=true`. An ordinary push therefore cannot apply 0339 while
the old images still serve traffic. This assertion is not a substitute for draining.

After subscriber verification/apply and the maintenance-window preparation above,
dispatch **Docker Images** on master with `billing_cutover=true`. The workflow saves
the current Fly configuration and machine topology for web, admin, realtime,
processor and cron, validates every process/region identity and the singleton
cron count, then scales every recorded process group in all five fleets to zero, and verifies that no machines remain (including
stopped machines, which Fly could auto-start). Only a successful drain passes the
offline assertion to the migration machine. Application volumes and databases are
not deleted. External schedulers/autoscalers must remain paused during this window.
The deployment recreates each application with its saved configuration and final
image, restores each recorded process/region count, removes deploy-seeded surplus
regions, and verifies the resulting topology. An unrecognized machine inventory
blocks draining; a restoration mismatch fails deployment. If migration or deployment fails, keep maintenance in place and recover with
the final image; never restart an old image after the column drop. Later ordinary
deploys pass without an offline assertion because the retired column is absent.

Fly behavior: [scaling to zero and redeployment](https://fly.io/docs/launch/scale-count/),
[configuration snapshots](https://fly.io/docs/flyctl/config-save/).

## Docker Compose and tenant upgrades

Both compose migration services forward `BILLING_CUTOVER_OFFLINE`, defaulting to
`false`. Do not persist `true` in `.env`. Before starting, back up the databases,
pause external workers/autoscalers and webhook delivery, and build or pull **all**
final candidate images, including migrate. Keep the same compose project name,
files, environment file and image tag throughout; changing the project can select
empty volumes instead of the existing deployment.

For a tenant, define a shell helper using that deployment's actual project and
existing environment file (substitute both paths/names):

```sh
dc() { docker compose --env-file /secure/tenant.env -p ps-TENANT -f infrastructure/docker-compose.tenant.yml "$@"; }
```

For the root on-prem stack, use its existing project name and environment file:

```sh
dc() { docker compose --env-file /secure/onprem.env -p EXISTING_PROJECT -f docker-compose.yml "$@"; }
```

Run the following in order, stopping on any nonzero exit. `down` removes old
containers so their restart policies cannot revive an old writer; **never add
`--volumes`**. Check that no containers from this project remain before starting
only the databases. Other deployments sharing this database must also be drained.

```sh
dc down --remove-orphans
test -z "$(dc ps -a -q)"
dc up -d postgres postgres-admin
# Use onprem instead of tenant for the root on-prem stack.
dc run --rm --no-deps -e DEPLOYMENT_MODE=tenant migrate bun scripts/migrate-founder-to-pro.ts --dry-run
dc run --rm --no-deps -e DEPLOYMENT_MODE=tenant migrate bun scripts/migrate-founder-to-pro.ts --apply
BILLING_CUTOVER_OFFLINE=true dc run --rm --no-deps migrate
dc run --rm --no-deps -e DEPLOYMENT_MODE=tenant migrate bun scripts/migrate-founder-to-pro.ts --dry-run
dc up -d --force-recreate
```

Each verifier must exit successfully with `ready: true`. For a billing-enabled
Compose deployment, use `DEPLOYMENT_MODE=cloud`, pass its existing Stripe
configuration into the one-off verifier, and mount/pass the verified Business
manifest described above. Never select tenant/onprem to bypass Stripe evidence;
the verifier rejects those modes when customer/subscription evidence exists.
The migration command runs the compose service's normal main/admin migrations and
admin-user provisioning. The final `up` may rerun migrations safely with the
assertion back at false because 0339 removed the retired column. Resume external
traffic/jobs only after the final images are healthy. If any step fails, leave
application containers down and repair using the candidate; never restart old
images against the contracted schema.
