# Billing release cutover package

This package prepares PR #2906, starting at `9ba6f806485656888189a095a922954421d721a5`.
**No deployment, live subscriber update, price activation, or webhook handover is authorized by this document.**
The exact frozen SHA, final CI runs, image digests, and acceptance results belong in the PR's linked handoff.
An unchecked item below is a launch gate, not an inferred pass.

## Prepared Stripe resources (2026-10-14)

Account: `acct_1S2LlQPRnBcvXFso` (`2witstudios`). All test calls use that account's CLI test credential.
Web and admin configurations use its matching public key and these identities:

| Resource | Test | Live |
| --- | --- | --- |
| Personal Pro | `price_1UQXAuPRnBcvXFsoA3uYJyHL` | `price_1SdfbXPRnBcvXFsoRbjnaQFS` |
| Organization base | `price_1UQXAvPRnBcvXFsoeKQE6H0u` | `price_1UQUXPPRnBcvXFsoIu4Bcxt3` |
| Extra seat | `price_1UQXAwPRnBcvXFso1TqKRFSM` | `price_1UQUXiPRnBcvXFso0992O0dz` |
| Personal portal | `bpc_1UQXAxPRnBcvXFsoYbIcbPsB` | `bpc_1UQXAzPRnBcvXFsoKdnU1dUr` |
| Organization portal | `bpc_1UQXAyPRnBcvXFsoHhQmOeSG` | `bpc_1UQXAzPRnBcvXFsoGwqBbnSf` |
| Prepared webhook | `we_1UQXDPPRnBcvXFsoL5617NOH` | `we_1UQXDRPRnBcvXFsofRZ5rvN1` |

Test prices are active, USD/month, licensed: Pro 1500 cents, base 5000, seat 1000; base metadata includes five seats.
Live organization prices remain inactive. The existing live destination `we_1S8OGXPRnBcvXFsodf8vuyam`
and default portal were not changed. Both new destinations are **disabled** at `2026-02-25.clover`, the application's pinned SDK version.
The six events are subscription created/updated/deleted, checkout completed, invoice paid/payment failed.
Stripe cannot create a v1 endpoint disabled: each was created on an unroutable `.invalid` URL,
disabled, then assigned the application URL. No staged endpoint could deliver to the application during preparation.

Both portal configurations enable billing details, payment methods, invoices and cancellation at period end.
Subscription plan/quantity updates are disabled. Seat purchases remain application-controlled.
Personal and organization sessions explicitly bind the corresponding configuration and customer.

Private handover directory: `~/.config/pagespace/billing-cutover-20261014/` (0700; files 0600).
Signing secrets exist only in `live-webhook-signing-secret-private.json` and
`test-webhook-signing-secret-private.json`. They are not in this repository or PageSpace.
The operator must transfer the live signing secret to the deployment secret store while deliveries are paused;
verify a signed event before enabling the new destination. Keep the old destination paused during validation;
replay any events created during the pause through the final handler, verifying ledger idempotency.
Matching test credentials are retained in `test-runtime.env` (0600); the current CLI credential expires 2027-01-12. Refresh it or obtain a durable test credential before a later rehearsal.

The real account-default test event snapshots are `2025-08-27.basil`. Signed real-event replay and
explicit canonical fixtures retrieved through the pinned Clover SDK cover both shapes.
Canonical fixtures are not captured network deliveries; record a real destination-delivery check at cutover.

## Owner's gifted Business → gifted personal Pro transition

Explicit destination: [business-destinations.json](business-destinations.json), user `c9wnmgofabm9edzco295dcfw` → Pro.
Subscription `sub_1Se0i3PRnBcvXFso6jDtRnrl`, customer `cus_TbD8ah9RMDHg9Y`, item `si_TbD8V4lG42ioCK`.
Existing anchor: `1765662639`. Existing discount: `di_1Se0i3PRnBcvXFsoZTuHhqJ2`.
The 100% forever coupon has one redemption, its maximum, and `valid:false` for another redemption.
Preserve the existing discount; do not redeem that coupon again.

The live **read-only invoice preview** `upcoming_in_1UQXDTPRnBcvXFsobHuQGDSl`
returned `amount_due:0`, `total:0` for Pro, quantity one, and no proration.
The live subscription itself is unchanged. Private inventory, preview, and transition preconditions are retained
in the handover directory. Immediately before execution, retrieve and compare the subscription, item,
customer, old Business price, anchor and discount; rerun the zero-charge preview. Abort on any mismatch.

The owner executes the following SDK update only during the cutover's subscriber phase:

```ts
await stripe.subscriptions.update('sub_1Se0i3PRnBcvXFso6jDtRnrl', {
  items: [{ id: 'si_TbD8V4lG42ioCK', price: 'price_1SdfbXPRnBcvXFsoRbjnaQFS', quantity: 1 }],
  proration_behavior: 'none',
  billing_cycle_anchor: 'unchanged',
  payment_behavior: 'error_if_incomplete',
  // Omit discounts: retain the existing discount; never redeem its exhausted coupon again.
}, { idempotencyKey: 'pagespace-business-pro-c9wnmgofabm9edzco295dcfw-v1' });
```

[Stripe update semantics](https://docs.stripe.com/api/subscriptions/update).
Verify unchanged subscription/item IDs, anchor, period dates, discount, latest invoice and credit balances.
The paying Pro subscriber and four other gifted Pro subscriptions are outside the destination manifest and unchanged.
Let the outgoing release reconcile the update's webhook before preflight. The production verifier deliberately
cannot report ready while the live Business price still exists; that owner step is a launch gate.

## Operator sequence

1. Freeze the owner-approved final SHA and record all final-head gates, 87/87 spec reports, and independent
   acceptance of the 18 findings. Record image digests for web/admin/realtime/processor/cron/migrate/imago;
   require the source revision label to equal the candidate. Image preparation can use:
   `gh workflow run docker-images.yml --ref <candidate-branch> -f build_only=true -f billing_cutover=false`.
   This mode neither publishes `latest` tags nor enters Fly deployment. Candidate images are
   `ghcr.io/2witstudios/pagespace-<service>:sha-<full-candidate-sha>`; retain digests, not just tags.
2. Record a production DB backup (artifact, timestamp, SHA-256, restore verification) and outgoing image IDs.
   Take an isolated restore; run the personal retirement, funding-proof recovery, wallet-ledger and tenant
   export/import rehearsals. Compare wallet value, funding composition, ledger/hold IDs and subscriber mirrors.
   Reapply tools/migrations and verify idempotency. Do not mark a synthetic fixture as a production-backup rehearsal.
3. Finish the explicit subscriber transition above on the outgoing release. Deliver its webhook and reconcile
   every mirror/tier. Run the production read-only preflight, with the actual production connection and live Stripe:
   `NEXT_PUBLIC_STRIPE_MODE=live bun scripts/migrate-founder-to-pro.ts --dry-run --business-manifest docs/billing-cutover/business-destinations.json`.
   Require `ready:true`; preserve the exact inventory and manifest hash. No other retired-tier destination is implicit.
4. On the outgoing release, complete pending `invoice.paid` retries and run `/api/cron/reconcile-credits` until
   missed grants are resolved. Require zero `credit_ledger` `entryType='missed_grant'` rows and preserve old grant terms.
5. Pause webhook delivery, inbound traffic, workers, schedulers and autoscalers. Back up the reconciled DB again.
   Run `bash scripts/fly-billing-cutover.sh --snapshot-only <snapshot-dir>` with `CUTOVER_CANDIDATE_SHA=<SHA>`.
   Retain all five app configs, machines/process/region counts, CANDIDATE, SHA256SUMS and COMPLETE.
   Upload and verify this sealed topology **before** any drain. Record artifact ID, original workflow run ID and retention.
6. Drain with `bash scripts/fly-billing-cutover.sh --drain <snapshot-dir>`. Verify all five fleets are empty;
   do not overwrite the original snapshot. Rerun subscriber preflight offline, then apply its manifest.
   Use the final migrate image with `BILLING_CUTOVER_OFFLINE=true`. The schema includes 0360/0361, funding proof
   0364, wallet ledger 0371/0372, and included funding composition 0377.
7. Inventory current paid org subscriptions missing funding proof. Verify each historical paid invoice and
   run `restore-org-funding-proof.ts` per [the funding runbook](../org-first-payment-cutover.md).
   It restores evidence, not grants. Record each proof and prove a rerun grants no money.
8. Disable plan/quantity updates in the old default portal `bpc_1S9pOoPRnBcvXFsoaosqwGzv` and verify retrieval,
   so legacy portal links cannot purchase retired plans. Bind final sessions to the separate prepared configurations.
   Activate only the two staged live organization prices, retrieve their exact terms, install the prepared
   webhook signing secret, and verify Clover payloads and signatures. Enable only the intended destination
   after the final handler is available. Retain the old destination disabled for handover audit.
9. Deploy/restore **final candidate images only** after schema contraction. Cutover workflow uses full-SHA
   image tags for migrations and each drained fleet. Restore the original process/region counts with
   `bash scripts/fly-billing-restore.sh <snapshot-dir> <app>` and the original candidate SHA.
   Verify recorded counts before resuming workers or deliveries; test retries, funding, balances and paid/gift entitlements.
10. Under maintenance, verify actual personal/org payments, invitations/seats, cancellation/reactivation, invoices,
    source disclosure, cross-window preference changes, cap/allocation refusal, and liability composition.
    Compare untouched subscribers to the initial inventory. Reopen traffic only after every launch gate passes.

## Recovery after interruption

A fresh runner must download the original `billing-cutover-topology` artifact, not snapshot the drained fleets.
For a new workflow execution, pass `topology_run_id=<original-run-id>` with `billing_cutover=true` on the **same candidate**.
An explicit missing artifact fails closed; checksum corruption, missing completion, or a different candidate is refused.
A same-run job retry uses `github.run_id`. Restore the sealed directory, set `CUTOVER_CANDIDATE_SHA`, and run the
restore script per app with the recorded final image identities. Preserve successful migration logs and machine exit code.
After 0361 contracts the schema, restoring an old application image is forbidden; forward recovery uses final images.
A full database rollback requires a coordinated pre-cutover DB restore and compatible outgoing images, with traffic paused.

## Evidence boundaries

The local database is an isolated restore of the existing **local test database**, not a production backup.
Local snapshot SHA-256: `0522b979acc0c5a326c5e75a32462a34580080a6f3b237c04f047448d6b10288`.
Disposable PostgreSQL image: `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
The live subscriber change, production backup/restore, production preflight, live destination delivery, image activation
and deployment remain owner launch steps. Actual production topology/artifact IDs cannot be supplied before its snapshot.
The handoff must keep those fields explicitly pending until recorded; test fake-Fly artifact IDs are not production IDs.
The original independent review remains authoritative until an independent acceptance record clears it.
See [finding and security matrix](findings.md). Test labels, assertions, coverage thresholds and the 87 specification criteria
are not waived by this package.
