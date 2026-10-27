/** The retired column cannot be dropped while an old application image can run. */
export function assertPersonalBillingCutoverOffline(hasRetiredColumn: boolean, offline: string | undefined): void {
  if (hasRetiredColumn && offline !== 'true') {
    throw new Error('Personal billing cutover requires offline application fleets. Follow docs/personal-billing-cutover.md and set BILLING_CUTOVER_OFFLINE=true only after draining old images.');
  }
}

/**
 * The org first-payment cutover ships in the same offline release: once org_subscription_funding
 * exists, an org without a proof for its current subscription reads `never_funded` (lapsed), so
 * adding it under existing org subscriptions needs the same drained fleet and the recovery in
 * docs/org-first-payment-cutover.md before traffic resumes. A database with no org subscriptions
 * yet, or one that already has the table, migrates as usual.
 */
export function assertOrgFundingCutoverOffline(
  schema: { fundingTableExists: boolean; hasOrgSubscriptions: boolean },
  offline: string | undefined,
): void {
  if (!schema.fundingTableExists && schema.hasOrgSubscriptions && offline !== 'true') {
    throw new Error('Organization first-payment cutover requires offline application fleets and funding recovery. Follow docs/org-first-payment-cutover.md and set BILLING_CUTOVER_OFFLINE=true only after draining old images.');
  }
}
