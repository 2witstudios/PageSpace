/**
 * Live in-flight Machine-run count for a payer — the same COUNT the
 * `too_many_in_flight` gate (`credit-gate.ts` evaluateGate) checks against
 * `MACHINE_MAX_INFLIGHT`, exposed read-only for display. Deliberately no
 * transaction/row-lock: this is advisory dashboard data, not a gating
 * decision, so a benign race with a concurrent hold insert/delete is fine.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, sql } from '@pagespace/db/operators';
import { creditHolds } from '@pagespace/db/schema/credits';

export async function getLiveMachineInFlight(userId: string): Promise<number> {
  const [row] = await db
    .select({ inFlight: sql<number>`count(*)` })
    .from(creditHolds)
    .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, new Date())));
  return Number(row?.inFlight ?? 0);
}
