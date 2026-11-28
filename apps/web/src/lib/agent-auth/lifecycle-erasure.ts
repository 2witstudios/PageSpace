/**
 * Erasing an abandoned agent (ADR 0008 Decision 13, [D-30]): an unclaimed
 * agent that never authenticated in 30 days is removed through the SAME GDPR
 * account-erasure path a person deleting their own account takes
 * (`lodgeAndEnqueueErasure`: a data-subject-request row as evidence, the
 * Stripe/Apple steps, an immediate `tokenVersion` bump, then the processor's
 * durable erasure job and its cascade) — never a raw `DELETE FROM users`.
 *
 * Fails closed: only an `accountType = 'agent'` row is ever lodged here, so a
 * bug upstream cannot erase a human. The decision that the agent is abandoned
 * is `decideAgentLifecycle`'s, taken by `sweepAgentLifecycle` before this runs.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentSyntheticEmail } from '@pagespace/lib/auth/agent/reserved-email';
import { automationActor, inDrives } from '@pagespace/lib/permissions/access-actor';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { lodgeAndEnqueueErasure } from '@/lib/erasure/request-erasure';

/** Recorded on the data-subject-request row: why this erasure happened with nobody asking. */
export const AGENT_LIFECYCLE_LEGAL_BASIS = 'agent_lifecycle: unclaimed agent never authenticated within 30 days (ADR 0008 D13)';

export async function eraseUnclaimedAgent(userId: string): Promise<void> {
  // Idempotent across ticks: an erasure already queued is simply in flight.
  if (await dataSubjectRequestRepository.findActiveErasureForUser(userId)) return;

  const [subject] = await db
    .select({ accountType: users.accountType, stripeCustomerId: users.stripeCustomerId, appleId: users.appleId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!subject || subject.accountType !== 'agent') {
    throw new Error('lifecycle erasure refused: subject is not an agent account');
  }

  await lodgeAndEnqueueErasure({
    subjectUserId: userId,
    // An agent's address is synthetic and derived from its id (ADR 0008 Decision 2).
    subjectEmail: agentSyntheticEmail(userId),
    stripeCustomerId: subject.stripeCustomerId,
    // No person is signing anything in: system work acting for the agent's own
    // account, confined to no drive. The service token it mints is bound to the
    // agent's own user resource, as a self-service erasure's is.
    caller: automationActor(userId, 'agent-lifecycle', inDrives()),
    requestedByType: 'self',
    forceDelete: false,
    legalBasis: AGENT_LIFECYCLE_LEGAL_BASIS,
    subjectAppleLinked: subject.appleId !== null,
  });
}
