/**
 * Suspend or reactivate a user account — the one implementation, shared by the
 * admin suspend route and content takedowns.
 *
 * Suspension sets `suspendedAt` / `suspendedReason` (enforced at login and
 * session validation) and revokes every live session so it takes effect at
 * once. Authorization, audit and request validation belong to the caller.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNotNull, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessionService } from './session-service';

export type SuspendUserResult =
  | { status: 'suspended'; revokedSessions: number }
  | { status: 'already_suspended' }
  | { status: 'not_found' };

export async function suspendUser(input: { userId: string; reason: string }): Promise<SuspendUserResult> {
  // Conditional on not already being suspended, so two concurrent suspensions
  // cannot overwrite each other's reason and timestamp.
  const [updated] = await db
    .update(users)
    .set({ suspendedAt: new Date(), suspendedReason: input.reason })
    .where(and(eq(users.id, input.userId), isNull(users.suspendedAt)))
    .returning({ id: users.id });

  if (!updated) {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
    return existing ? { status: 'already_suspended' } : { status: 'not_found' };
  }

  // Kill every live session so the suspension takes effect immediately.
  const revokedSessions = await sessionService.revokeAllUserSessions(input.userId, 'admin_suspension');
  return { status: 'suspended', revokedSessions };
}

export type UnsuspendUserResult = { status: 'reactivated' } | { status: 'not_suspended' } | { status: 'not_found' };

export async function unsuspendUser(userId: string): Promise<UnsuspendUserResult> {
  const [updated] = await db
    .update(users)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(and(eq(users.id, userId), isNotNull(users.suspendedAt)))
    .returning({ id: users.id });

  if (updated) return { status: 'reactivated' };
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return existing ? { status: 'not_suspended' } : { status: 'not_found' };
}
