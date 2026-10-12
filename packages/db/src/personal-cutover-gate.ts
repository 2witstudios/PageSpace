/** The retired column cannot be dropped while an old application image can run. */
export function assertPersonalBillingCutoverOffline(hasRetiredColumn: boolean, offline: string | undefined): void {
  if (hasRetiredColumn && offline !== 'true') {
    throw new Error('Personal billing cutover requires offline application fleets. Follow docs/personal-billing-cutover.md and set BILLING_CUTOVER_OFFLINE=true only after draining old images.');
  }
}
