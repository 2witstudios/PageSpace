/**
 * Whether the sandbox COMPUTE tool families should be REGISTERED for this
 * request — a UX gate, not the security boundary (that's `canRunCode`,
 * re-checked at call time by the tool-gate/runner chain). Without this, a
 * request would see bash/git tool definitions that hard-fail the moment
 * they're called, and the GitHub OAuth integration tools would stay wrongly
 * suppressed (their suppression keys on sandbox git tool NAMES being present
 * in the resolved set, regardless of whether those tools would actually
 * work).
 *
 * ACTOR-AWARE via the same centralized capability provisioning enforces
 * (review #2326, codex round 9): exposure delegates to `canRunCodeForSession`
 * — kill switch, the PAYER's tier (drive owner, else the session/request
 * owner — the same rule billing/quota apply, so a free-tier member of a
 * Pro-owned drive still passes the tier leg), AND the requester's own drive
 * edit access. Payer tier alone advertised bash/git to viewer-role members
 * whose every call then died at `canRunCode`'s drive-role check.
 */

import { canRunCodeForSession } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';

/** `driveId`: the agent page's own drive (null for the global assistant). */
export async function resolveSandboxToolEligibility(
  driveId: string | null,
  userId: string,
): Promise<boolean> {
  return canRunCodeForSession({ userId, driveId, ownerId: userId });
}

/**
 * Conversation-aware variant — the BOUND SESSION's coordinates first (review
 * #2326): provisioning and billing key on the session a conversation is bound
 * to (its drive's owner, else the session's own owner), and a conversation
 * can be hosted in a session whose payer differs from the calling surface —
 * a page agent consulted inside a driveless Global session, or a Global
 * Assistant merely visiting a drive. The requester (`userId`) is always the
 * ACTOR the capability check authorizes.
 *
 * An UNBOUND conversation splits by surface, mirroring the acquire path
 * (`resolveOrProvisionSession`) exactly (codex round 14):
 *
 *  - `'global'`: the first compute call auto-provisions a DRIVELESS session
 *    the requester pays for, so eligibility is the driveless coordinates.
 *  - `'page'`: acquire answers `no_session` — page conversations are never
 *    lazily minted into a session (that per-conversation minting is the
 *    conflation the session model removed), so compute tools could only
 *    ever hard-fail, and their git tool NAMES would suppress the user's
 *    working GitHub integration tools. Not eligible.
 */
export async function resolveSandboxToolEligibilityForConversation(
  conversationId: string | undefined,
  surface: 'page' | 'global',
  userId: string,
): Promise<boolean> {
  const { findSessionForConversation } = await import('@/lib/agent-workspaces/agent-workspaces-runtime');
  const session = conversationId ? await findSessionForConversation(conversationId) : null;
  if (session) {
    return canRunCodeForSession({ userId, driveId: session.driveId, ownerId: session.ownerId });
  }
  if (surface === 'page') return false;
  if (await canRunCodeForSession({ userId, driveId: null, ownerId: userId })) return true;
  // Last: a GLOBAL conversation whose own coordinates are ineligible may still
  // be able to run in an environment it can reach — a free-tier person who owns
  // a visible machine in a Pro-owned drive is eligible THERE, because the tier
  // leg keys on the PAYER (see this module's own header, and `canRunCode`'s).
  // Without this the compute family is stripped from the request before
  // `list_environments` can be called at all, so fixing the tool's own gate
  // alone would change nothing (Codex P1, #2616).
  return hasEligibleReachableEnvironment(userId);
}

/**
 * Does this user own any environment, visible to the global assistant, whose
 * PAYER would authorize them? Bounded (owner-scoped, capped by the store's own
 * listing limit) and reached only after the cheap check has already failed.
 *
 * The probe has the same shape the run will be gated with: the environment's
 * payer, and NO drive — a local env authorizes on machine ownership, which the
 * listing has already established for every row it returns. `false` on any
 * error: this widens eligibility, so it must fail closed.
 */
async function hasEligibleReachableEnvironment(userId: string): Promise<boolean> {
  try {
    const { isLocalEnvsEnabled } = await import('@pagespace/lib/services/drive-envs/local-envs-enabled');
    if (!isLocalEnvsEnabled()) return false;
    const { listGlobalAssistantEnvironments, resolveDriveEnvPayer } = await import('@/lib/drive-envs/drive-envs-runtime');
    const environments = await listGlobalAssistantEnvironments(userId);
    for (const env of environments) {
      const payer = await resolveDriveEnvPayer(env.driveId);
      if (payer && (await canRunCodeForSession({ userId, driveId: null, ownerId: payer.payerId }))) return true;
    }
    return false;
  } catch {
    return false;
  }
}
