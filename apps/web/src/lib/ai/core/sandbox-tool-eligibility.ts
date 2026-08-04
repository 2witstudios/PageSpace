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

import { canRunCodeForSession } from '@pagespace/lib/services/agent-sessions/agent-session-tenant';

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
 * Assistant merely visiting a drive. Only an UNBOUND conversation falls back
 * to the surface's own coordinates (`fallbackDriveId` = the agent page's
 * drive, or null for the global assistant, whose auto-spawned session the
 * user pays for). The requester (`userId`) is always the ACTOR the capability
 * check authorizes.
 */
export async function resolveSandboxToolEligibilityForConversation(
  conversationId: string | undefined,
  fallbackDriveId: string | null,
  userId: string,
): Promise<boolean> {
  const { findSessionForConversation } = await import('@/lib/agent-sessions/agent-sessions-runtime');
  const session = conversationId ? await findSessionForConversation(conversationId) : null;
  return session
    ? canRunCodeForSession({ userId, driveId: session.driveId, ownerId: session.ownerId })
    : canRunCodeForSession({ userId, driveId: fallbackDriveId, ownerId: userId });
}
