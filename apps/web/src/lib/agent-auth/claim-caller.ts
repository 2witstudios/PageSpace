/**
 * The I/O edge of `decideClaimCaller` (ADR 0008 security review addendum): is
 * this authenticated caller the agent ITSELF, presenting the credential this
 * claim door accepts? The credential class comes from `resolveCallerCredential`
 * (which reads an `account`-scoped token's issuance); the account type is read
 * only for a session — an `agent_grant_token`'s principal was already proven
 * to be an agent by that classification.
 *
 * Every claim route asks this before it touches a claim, so a claim is started
 * and polled only by the agent it belongs to — never by a claim-token holder,
 * a human (an approver, a former owner), or a client the agent granted access.
 */
import type { AuthResult } from '@/lib/auth';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { decideClaimCaller, type ClaimDoor } from '@pagespace/lib/auth/agent/caller-policy';
import { resolveCallerCredential } from './caller-credential-resolver';

export type ClaimCaller = { ok: true; agentUserId: string } | { ok: false };

export async function resolveClaimCaller(auth: AuthResult, door: ClaimDoor): Promise<ClaimCaller> {
  const credential = await resolveCallerCredential(auth);
  const accountType = credential === 'agent_grant_token'
    ? 'agent'
    : credential === 'session'
      ? await sessionRepository.findAccountType(auth.userId)
      : null;
  return decideClaimCaller({ door, credential, accountType }).status === 'ok'
    ? { ok: true, agentUserId: auth.userId }
    : { ok: false };
}
