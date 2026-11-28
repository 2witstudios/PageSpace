/**
 * org-compute-epoch-core — the PURE rule for accrual an org row carried from before org compute
 * billing went live (WAL-9; point-guard ruling on ow-c7b).
 *
 * Until this lane, every compute meter REFUSED an org payer and left the row's watermark where it
 * was, so an org env/app/session row arrives at its first org-billed tick carrying a backlog from
 * a time nothing could bill an org. That backlog is forgiven, never charged: the billable window
 * starts at the later of the watermark and the EPOCH — the instant org compute billing went live
 * on this deployment, stamped once by the first tick that meets an org row (`org-compute-epoch.ts`).
 *
 * A row whose watermark is at or after the epoch bills normally, which is every row created or
 * moved into an org after the epoch, and every row on its second org-billed tick.
 */

/** The start of an org row's billable window when it carries pre-epoch accrual; null when nothing is forgiven. */
export function orgBacklogStart(input: { watermark: Date; epoch: Date }): Date | null {
  return input.watermark.getTime() < input.epoch.getTime() ? input.epoch : null;
}
