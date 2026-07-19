/**
 * Live in-flight credit-hold count for a payer — the same COUNT the
 * `too_many_in_flight` gate (`credit-gate.ts` evaluateGate) checks against a
 * caller-supplied `maxInFlight` (e.g. `MACHINE_MAX_INFLIGHT` for Machine
 * runs, `MAX_FREE_INFLIGHT` for free-tier chat). `credit_holds` has no
 * per-source column — a hold's origin (chat/voice/machine) is only known
 * once it settles into `aiUsageLogs`, which hasn't happened yet while it's
 * still a hold — so this intentionally counts ALL of the payer's in-flight
 * AI activity, not machine-specific sessions. That's exactly right for its
 * purpose: it's the literal number that will trip `too_many_in_flight` on
 * the payer's NEXT call, regardless of call type.
 *
 * Deliberately no transaction/row-lock: this is advisory dashboard data, not
 * a gating decision, so a benign race with a concurrent hold insert/delete
 * is fine.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, sql } from '@pagespace/db/operators';
import { creditHolds } from '@pagespace/db/schema/credits';

export async function getLiveInFlightHolds(userId: string): Promise<number> {
  const [row] = await db
    .select({ inFlight: sql<number>`count(*)` })
    .from(creditHolds)
    .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, new Date())));
  return Number(row?.inFlight ?? 0);
}
