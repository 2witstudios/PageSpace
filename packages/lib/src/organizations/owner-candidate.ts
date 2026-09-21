/**
 * ORG-1: an org has one HUMAN Owner. createOrganization and transferOwnership ask
 * here before anyone becomes Owner, so an agent never does.
 *
 * Today a users row is a person: agent accounts are not users rows yet
 * (schema/agent-accounts.ts is types only), and an AI agent is a page. When agent
 * accounts become users rows, loadOrgPrincipalKind is the one place that must
 * answer 'agent' for them.
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';

export type OrgPrincipalKind = 'human' | 'agent';

export type OrgOwnerCandidateDecision =
  | { ok: true }
  | { ok: false; status: 400; reason: 'owner_not_human' }
  | { ok: false; status: 404; reason: 'owner_not_found' };

export const decideOrgOwnerCandidate = (kind: OrgPrincipalKind | null): OrgOwnerCandidateDecision => {
  if (kind === null) return { ok: false, status: 404, reason: 'owner_not_found' };
  if (kind === 'agent') return { ok: false, status: 400, reason: 'owner_not_human' };
  return { ok: true };
};

type Executor = Pick<typeof db, 'select'>;

/** What `id` names: a person (a users row), an AI agent (an AI_CHAT page), or nothing. */
export async function loadOrgPrincipalKind(executor: Executor, id: string): Promise<OrgPrincipalKind | null> {
  const [user] = await executor.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (user) return 'human';
  const [agent] = await executor
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.id, id), eq(pages.type, 'AI_CHAT')))
    .limit(1);
  return agent ? 'agent' : null;
}
