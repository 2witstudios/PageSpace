/**
 * The account facts the credit gate needs beyond the balance row (ADR 0007
 * Decision 9): is this principal an agent, and has a human claimed it. One
 * indexed read, taken only on the paths that need it — a lazy starter-grant
 * init, or an `out_of_credits` denial being refined — never on the hot allow
 * path over an existing, funded row.
 *
 * Kept in its own module so the gate's unit tests (which script every `db`
 * call) can stub it with one line.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import type { AccountType } from '../auth/agent/account-type';

export interface GateAccount {
  accountType: AccountType;
  /** `agent_identities.ownerUserId` — null for a human or an unclaimed agent. */
  ownerUserId: string | null;
}

export async function readGateAccount(userId: string): Promise<GateAccount> {
  const [row] = await db
    .select({ accountType: users.accountType, ownerUserId: agentIdentities.ownerUserId })
    .from(users)
    .leftJoin(agentIdentities, eq(agentIdentities.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  // No users row: the gate has never been reachable without one (every caller
  // authenticated a user), and `human` is the column default.
  return { accountType: row?.accountType ?? 'human', ownerUserId: row?.ownerUserId ?? null };
}
