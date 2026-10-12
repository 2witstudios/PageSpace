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
bun run db:migrate
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
