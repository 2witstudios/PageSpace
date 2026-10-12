# Organization first-payment cutover

**Release:** migration 0342 (`org_subscription_funding`) ships in the SAME offline release as the
[personal billing cutover](personal-billing-cutover.md) (0338/0339): both land with the
Organizations & Wallets epic merge, and the one drained-fleet maintenance window covers both.
The migrate entrypoint enforces it: while `org_subscription_funding` does not exist yet and
`org_subscriptions` has rows, `db:migrate` refuses to run unless `BILLING_CUTOVER_OFFLINE=true`
(`assertOrgFundingCutoverOffline` in `packages/db/src/personal-cutover-gate.ts`), exactly like the
personal gate. Without it, a rolling deploy would add the table and every existing paying org would
read `never_funded` (lapsed, nothing lost or wrongly granted) until the recovery below ran. A
database with no org subscriptions yet (a new install) and every deploy after the table exists
migrate as usual.

Migration 0342 creates `org_subscription_funding` without inferring payment from
wallet balances, cached tiers or Stripe's active status. In billing-enabled
deployments, an organization remains lapsed until its **current** subscription
has a verified positive payment or supported gift. A predecessor's proof cannot
activate a replacement. Billing-disabled deployments do not need this evidence.

New paid invoices record evidence through the normal funding path. Already
processed webhook events are deduplicated, so resending an old event is not a
historical recovery procedure. Before opening the final application to traffic,
identify existing subscriptions that need evidence:

```sql
SELECT o.id, o."stripeCustomerId", s."stripeSubscriptionId", s.status
FROM organizations o
JOIN org_subscriptions s ON s."orgId" = o.id
LEFT JOIN org_subscription_funding f
  ON f."orgId" = o.id AND f."stripeSubscriptionId" = s."stripeSubscriptionId"
WHERE f.id IS NULL;
```

For each previously funded current subscription, choose an actual paid invoice
from its Stripe history. Use the final candidate checkout or migrate image with
the target database, deployment mode, Stripe mode/key, and audit configuration.
Run the verification first, save its output with the deployment evidence, then
apply explicitly:

```sh
bun scripts/restore-org-funding-proof.ts --org ORG_ID --invoice INVOICE_ID --dry-run
bun scripts/restore-org-funding-proof.ts --org ORG_ID --invoice INVOICE_ID --apply
```

The tool retrieves the invoice and every line directly from Stripe, checks paid
status and the exact current organization/customer/subscription binding, and
uses the normal funding price and gift rules. Unknown replacement charges,
incomplete retrieval, zero non-gifts and predecessor invoices fail verification.
Apply rechecks the local binding under locks and inserts at most one proof. It
makes **no Stripe, wallet or ledger writes** and does not recalculate historical
credit using the new ratio. Successful insertion emits the billing audit event
and org status notification; repeated apply is a no-op.

Apply migration 0342 before running the tool. For Docker/tenant/Fly installations,
retain the maintenance sequence in [personal billing cutover](personal-billing-cutover.md)
while completing recovery. Do not run an old application image against the final
schema. Organizations that never paid or received a supported gift must remain
lapsed and use paid checkout. Missing subscription mirrors must first be repaired
through the verified billing recovery path; never manufacture a mirror, receipt
or credit balance to make verification pass. Validate active/lapsed behavior,
billing access and a representative member surface before resuming traffic.
