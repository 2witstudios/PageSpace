/**
 * person-bound-scope — WHICH rows a per-person gate bound counts (WAL-9).
 *
 * The gate bounds a PERSON, whichever wallet pays: the daily exposure cap sums the person's
 * ledger charges, and the in-flight and reserved counts sum the person's holds. Org-paid
 * compute names a person on its rows only because credit rows must (the session's owner, or
 * the drive lead for an accrual nobody ran), so counting it in that person's bounds lets the
 * lead's unrelated AI spend refuse an org app's wake, and an org accrual eat the lead's own AI
 * headroom — the same "person named on a row the org paid" problem the seat reads fixed with
 * `spendKind` (seat-allowance's SEAT_COUNTED_SPEND_KINDS).
 *
 * Two scopes, never mixed, so nothing is uncapped and nothing is double-counted:
 *   - 'person'      every row EXCEPT org-paid compute. A person's AI, and their own personal-wallet
 *                   compute, count exactly as before; this is every gate but the org pool's.
 *   - 'org_compute' ONLY org-paid compute. The org pool's compute gate bounds a person by what
 *                   THEY ran on the pool, not by their AI, so the per-person bound on org
 *                   compute stays (this is not the per-member pool cap, which is a separate scope).
 *
 * Org-paid compute = a row of a compute kind ('compute' a person ran, or a 'drive_compute'
 * accrual) on an org POOL wallet (the org-owned root: no subject, no parent). A row with no
 * wallet is never org-paid.
 *
 * INVARIANT: zero I/O; these are SQL fragments the gate composes into its own queries.
 */

import { sql, type SQL } from '@pagespace/db/operators';
import { creditHolds, creditLedger, type SpendKind } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';

export type PersonBoundScope = 'person' | 'org_compute';

const orgPoolWalletIds = sql`(SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.ownerType} = 'org' AND ${wallets.subjectType} IS NULL AND ${wallets.parentWalletId} IS NULL)`;

const isOrgPaidComputeLedgerRow = sql`(${creditLedger.spendKind} IN ('compute', 'drive_compute') AND coalesce(${creditLedger.walletId} IN ${orgPoolWalletIds}, false))`;
const isOrgPaidComputeHold = sql`(${creditHolds.spendKind} IN ('compute', 'drive_compute') AND coalesce(${creditHolds.walletId} IN ${orgPoolWalletIds}, false))`;

/** The spend kinds that are compute, whoever ran it. */
export function isComputeSpendKind(spendKind: SpendKind | undefined): boolean {
  return spendKind === 'compute' || spendKind === 'drive_compute';
}

/** The scope the gate applies for a call of `spendKind` paid from `source` (null source = the org pool's own compute). */
export function personBoundScopeFor(input: { spendKind?: SpendKind; source: string | null }): PersonBoundScope {
  return isComputeSpendKind(input.spendKind) && input.source === null ? 'org_compute' : 'person';
}

/** The ledger rows one person's bounds count in `scope`. */
export function ledgerRowsInScope(scope: PersonBoundScope): SQL {
  return scope === 'org_compute' ? isOrgPaidComputeLedgerRow : sql`NOT ${isOrgPaidComputeLedgerRow}`;
}

/** The holds one person's bounds count in `scope`. */
export function holdsInScope(scope: PersonBoundScope): SQL {
  return scope === 'org_compute' ? isOrgPaidComputeHold : sql`NOT ${isOrgPaidComputeHold}`;
}
