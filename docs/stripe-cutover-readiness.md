# Stripe readiness for the Organizations & Wallets cutover

Updated 2026-10-14: [the current operator package](billing-cutover/README.md) supersedes the preparation gates below.
The confirmed account now has active test prices, matching public configuration, separate personal/org portals,
and disabled Clover replacement destinations with privately retained signing secrets. The owner's explicit Pro
manifest and zero-charge live preview are prepared. Live subscriptions, existing destination/default portal,
inactive live org prices, and deployment remain unchanged.

**Final clearance is pending** final-head CI, all 87 specification IDs and independent acceptance.
Production preflight, backup/restore, real live destination delivery and cutover remain owner launch gates.
See the package's explicit evidence boundaries; a passing focused test is not complete acceptance.

## Historical inventory and preparation record

Prepared 2026-10-14 from read-only Stripe inventory and the candidate at
`14405ed4` (before this integration commit). **Not ready to cut over.** This record supplements
[personal billing cutover](personal-billing-cutover.md) and
[organization first-payment cutover](org-first-payment-cutover.md); it does not
authorize changing a subscriber's plan or starting maintenance.

## Account and verified inventory

The CLI live account is `acct_1S2LlQPRnBcvXFso`, account email
`2witstudios@gmail.com`, display name `2witstudios`. Charges and payouts are enabled.
The live application publishable key and configured Pro price use this account.

The complete live subscription list has 51 records: 6 active, 14 canceled and
31 incomplete-expired. Five active subscriptions use configured Pro
`price_1SdfbXPRnBcvXFsoRbjnaQFS` ($15/month); one uses retired personal Business
`price_1SdfbePRnBcvXFsoCvpJsSxw` ($100/month). No subscription schedules were
returned. These observations do not establish that local subscription mirrors,
cached tiers, grandfathered accounts or wallet balances are reconciled.

The existing $50/month price `price_1SdfbbPRnBcvXFsofn7L1leP` belongs to
**Founder Plan**, not the new organization plan. Do not reuse it for organization
entitlement. Web and admin now reference the distinct staged live organization
prices below. They are inactive in Stripe and must be activated for checkout.

| Catalog entry | Stripe identity | Verified state |
| --- | --- | --- |
| Organization Business product | `prod_VRNHUFC0aLQK8l` | Active product, no default price |
| Monthly base | `price_1UQUXPPRnBcvXFsoIu4Bcxt3` | Inactive, USD 5000 cents/month, licensed, `included_seats=5` |
| Monthly extra seat | `price_1UQUXiPRnBcvXFso0992O0dz` | Inactive, USD 1000 cents/month, licensed |

Both prices belong to this product and live account. Lookup keys are
`pagespace_org_business_base_monthly` and `pagespace_org_extra_seat_monthly`.
Creation was followed by direct retrieval: creating an inactive price with
`product_data` returned an error while assigning the product's default price,
but persisted the base price and product. Retrieval confirmed both; no duplicate
was created. The extra-seat price was created on that same existing product.

The CLI default test mode returns the same account ID with no prices. The app's
test configuration uses a different account prefix (`PCGvbSozob`) and retrieving
its organization prices through the default CLI test context returns
`resource_missing`. This does NOT establish a different owner: confirm whether
that account is a sandbox under the same login and select its credentials, or
provision and configure a test catalog under the confirmed account. Verify the
test Pro price and publishable key too; price IDs alone do not fix an account mismatch.

## Advance preparation gates

1. Create a distinct organization Business product and two licensed recurring
   USD monthly prices: base 5000 cents, quantity 1, metadata `included_seats=5`;
   extra seat 1000 cents, quantity `max(0, seats - 5)`. No org trial. Proposed
   lookup keys: `pagespace_org_business_base_monthly` and
   `pagespace_org_extra_seat_monthly`. Stage inactive prices, record IDs, then
   activate for the release. Validate amounts, currency, interval, mode and metadata.
2. The staged IDs are wired into both `apps/web/src/lib/stripe-config.ts` and
   `apps/admin/src/lib/stripe-config.ts` before building the final images. Preserve
   the configured $15 personal Pro price. Run the real Stripe test-mode subscription
   and signed webhook integration tests against the resolved test account, plus
   the candidate's build/typecheck/lint and migration gates.
3. Prepare the portal replacement. Default configuration
   `bpc_1S9pOoPRnBcvXFsoaosqwGzv` currently offers retired $199.99 and $29.99
   prices and adjustable quantities. Remove these purchase paths at cutover.
   Personal portal must not offer organization prices; organization portal must
   not offer personal prices or allow reducing seats below held seats. Use
   separate portal configurations where needed, and explicitly bind sessions
   to them in the application. Verify payment updates, invoices and cancellation.
4. Resolve the active retired Business subscriber's explicit Free/Pro destination,
   timing and proration terms. Do not infer an organization purchase. Reconcile
   all local personal billing evidence and prepare the user-ID destination
   manifest required by `migrate-founder-to-pro.ts`. Run its dry-run against the
   target production DB with live Stripe mode; require `ready: true`.
5. Verify the deployed Stripe secret key belongs to this live account and its
   webhook secret matches the destination. Secret presence alone is not evidence
   of account/signing-secret correctness. Keep secret values out of this record.
6. Review webhook payload compatibility: destination
   `we_1S8OGXPRnBcvXFsodf8vuyam` is enabled at
   `https://pagespace.ai/api/stripe/webhook`, version `2025-08-27.basil`; the SDK
   requests `2026-02-25.clover`. All six handled events are subscribed:
   subscription created/updated/deleted, checkout completed, invoice paid and
   invoice payment failed. Test the actual destination payload shape against
   the candidate, especially invoice subscription and line identity. If a new
   destination/version is required, stage it disabled with its signing secret
   and define a delivery handover; do not replace the running destination early.

**Catalog preparation complete:** after the owner fixed CLI permissions, both
inactive prices were created and their live IDs wired into web/admin configuration.
Steps 1–2 still require activation and release verification. No subscription or
charge was created. Activate only in the maintenance sequence, checking each
response for an error (this CLI can exit zero on an API error):

```sh
stripe prices update price_1UQUXPPRnBcvXFsoIu4Bcxt3 --live --active=true --confirm
stripe prices update price_1UQUXiPRnBcvXFso0992O0dz --live --active=true --confirm
stripe prices retrieve price_1UQUXPPRnBcvXFsoIu4Bcxt3 --live
stripe prices retrieve price_1UQUXiPRnBcvXFso0992O0dz --live
```

Require `active: true` plus the identities and terms in the table above. If
activation fails, keep maintenance in place and resolve it before checkout.

Preparation verification: direct live retrieval confirmed both staged prices'
amounts, currency, licensed monthly recurrence, product binding, inactive status
and base seat metadata. Importing both application configs with
`NEXT_PUBLIC_STRIPE_MODE=live` confirmed identical configuration and exact staged
price IDs. The existing price-identity and organization subscription-adapter
unit suites passed (8 tests). This is not a real payment/webhook integration test
or a production database preflight; those remain release gates.

## Maintenance window order

1. Freeze the exact candidate SHA and save the validated inventory, manifest,
   test results, DB backup and fleet topology. Pause external schedulers and
   autoscalers. Finish explicit subscriber changes while the outgoing release
   can reconcile their webhooks and mirrors.
2. On the OUTGOING release, let pending `invoice.paid` retries land and run
   `/api/cron/reconcile-credits` until no missed grants remain. Require zero
   `credit_ledger` rows with `entryType = 'missed_grant'`; resolve indeterminate
   grants. The final release grants 60% of paid subscription value, so it cannot
   repair missed old grants at their old terms. Preserve existing credit value.
3. Pause webhook delivery, traffic and billing workers; drain all five fleets
   (web, admin, realtime, processor, cron). Rerun subscriber preflight and apply
   the verified manifest while offline. Require successful `ready: true` output.
4. Dispatch the final-image workflow with `billing_cutover=true` per the personal
   runbook. It saves/drains topology before migrating with the offline assertion.
   The coordinated schema changes include personal retirement 0360/0361,
   org funding evidence 0364 and wallet-ledger 0371/0372. Never restart old images
   against the contracted schema, including after a failed deploy.
5. Before reopening traffic, inventory existing org subscriptions missing proof
   using the query in the organization funding runbook. For each previously funded
   CURRENT subscription, verify and explicitly apply
   `restore-org-funding-proof.ts` with a real historical paid invoice. It restores
   evidence without new wallet grants; replaying a processed event is insufficient.
6. Activate the new catalog and final portal configuration; complete any validated
   webhook version/secret handover. Restore only final images and the saved process
   counts. Resume deliveries and workers under maintenance, verify reconciliation,
   then reopen traffic after the acceptance checks below.

## Acceptance evidence before closing maintenance

- Personal Free/Pro entitlement matches Stripe and no retired personal tier remains.
- Existing credit value and wallet/ledger opening balances reconcile; duplicate
  delivery grants nothing twice. Pro's full-price new invoice grants the allowance
  derived by the canonical money-model module.
- Organization first payment succeeds with a distinct customer, base x1 and seat
  x0; included and extra-seat grants match the canonical money-model derivation.
  Discounts and prorations derive grants from actual paid value.
- Invite beyond included seats, pending-invite counting, auto-add off refusal,
  prorated addition, deferred seat removal and same-period reuse work.
- Failed/canceled/never-funded orgs lapse without deleting content; paid reactivation
  works. Members cannot see billing; Owner/Admin portal access targets the org customer.
- Top-ups, invoice history, webhook retries, org funding proof and credit
  reconciliation pass against the final release. Confirm money/credits copy
  across web, admin, marketing, CLI and MCP.
- Record representative drive-wallet spend, allocation/cap refusal, source
  disclosure and org compute payer behavior for the whole-epic activation checks.

Re-inventory immediately before execution; the counts above are a preparation
snapshot, not permission to skip the production verifier. Subscriber destination,
production DB readiness, test-account mapping and payload compatibility remain
unresolved. Only the organization catalog and candidate configuration were changed;
no subscriptions, portal settings, webhook destinations or deployment state changed.
