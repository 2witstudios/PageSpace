/**
 * The ONE agent-session access decision.
 *
 * Both enforcement points — the web API routes and the realtime shell-connect
 * handler — call this function. That is the concrete mitigation for the risk
 * that the two surfaces drift apart: they cannot, because there is only one
 * decision, and its input shape is constructible from either side (a requester
 * id, the session row's own identity columns, and one fact the caller looks
 * up: the requester's drive membership).
 *
 * A session is a DRIVE-LEVEL workspace (contract invariant 1), so access is
 * drive access. The old model gated on conversation ownership and agent-page
 * permission; both dissolved with the conflation — a session hosts many
 * conversations with many agents, so neither a single thread's sharing state
 * nor a single page's ACL can speak for it. The drive can, and does.
 *
 * Two gates, evaluated in a fixed order so a denial always names the FIRST
 * thing wrong:
 *
 *  1. **Requester** — a non-empty id. Fails closed on the degenerate input.
 *  2. **Scope** — for a drive session, the requester must be the drive's owner
 *     or a member (any drive collaborator may work in the drive's sessions —
 *     that is what makes them shared working contexts). For a global-assistant
 *     session (`driveId` null) there is no drive to share through, so it is
 *     owner-only by construction. The gate applies to the session's OWNER too:
 *     an owner removed from the drive loses USE of its working context (see
 *     the END variant for why release-of-compute is different).
 *
 * Deliberately NO `canRunCode` gate here: the session surface (list, detail,
 * conversations, chat, panes) is open to every authenticated user with scope
 * access — only the SANDBOX (real compute: Sprite provisioning, PTY attach,
 * code-execution tools) is capability-gated, and each of those chokepoints
 * consults `canRunCode` itself (`ensureAgentSessionSandbox`'s authorize seam,
 * the tool gate, and the realtime shell-attach wiring). Weighing `canRunCode`
 * here made a free-tier payer — or a plain drive member — unable to even open
 * a chat-only session (review #2326: the tier gate inside `canRunCode` leaked
 * into the non-compute surface).
 *
 * Everything fails closed: an unresolved membership (`null`) denies, and an
 * empty requester denies.
 */

/**
 * The session columns the decision needs — no more, so both surfaces can build
 * it from a single row read, and the SPAWN path can build it for a session
 * that does not exist yet (there is deliberately no id here: the decision
 * never keys on WHICH session, only on whose it is and where it lives —
 * carrying an id forced pre-mint callers to fabricate an
 * `'about-to-be-minted'` sentinel, a fake value in a typed interface).
 */
export interface AgentSessionAccessSubject {
  ownerId: string;
  /** null = a global-assistant session: no drive, so no drive to derive access from. */
  driveId: string | null;
}

/**
 * What the caller determined about the requester's relationship to the DRIVE.
 * `null` = not resolved (denied — unknown is never a grant). `'admin'` is
 * distinguished from `'member'` because the END decision needs delete
 * authority (drive owner/admin), which centralized drive-root permissions
 * deny to plain members; the main surface decision treats them identically.
 */
export type DriveMembership = 'owner' | 'admin' | 'member' | 'none';

export type AgentSessionDenialReason =
  | 'invalid_requester'
  | 'drive_access_denied'
  | 'global_assistant_not_owner'
  | 'code_execution_denied'
  | 'delete_authority_required';

export type AgentSessionAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentSessionDenialReason };

export interface DecideAgentSessionAccessInput {
  requesterId: string;
  session: AgentSessionAccessSubject;
  /** The requester's membership in `session.driveId`. Ignored (may be null) for a global-assistant session. */
  driveMembership: DriveMembership | null;
}

export function decideAgentSessionAccess({
  requesterId,
  session,
  driveMembership,
}: DecideAgentSessionAccessInput): AgentSessionAccessDecision {
  if (requesterId.length === 0) {
    return { allowed: false, reason: 'invalid_requester' };
  }

  const isOwner = requesterId === session.ownerId;

  if (session.driveId === null) {
    // A global-assistant session has no drive to share through — it stays
    // private to its owner.
    if (!isOwner) return { allowed: false, reason: 'global_assistant_not_owner' };
  } else if (driveMembership !== 'owner' && driveMembership !== 'admin' && driveMembership !== 'member') {
    // Includes an unresolved membership (`null`): unknown is denied. Applies
    // to the session owner too — losing the drive loses its working contexts.
    return { allowed: false, reason: 'drive_access_denied' };
  }

  return { allowed: true };
}

export interface DecideAgentSessionEndAccessInput extends DecideAgentSessionAccessInput {
  /**
   * Whether the requester holds the code-execution capability, computed by the
   * centralized `canRunCode` checker. Consumed ONLY by the END decision (below)
   * — ending a session is destructive release-of-compute, not part of the free
   * session surface, so non-owners stay capability-gated (review finding H3).
   */
  canRunCode: boolean;
}

/**
 * The END-SESSION variant: ONE deliberate widening, for the owner only.
 *
 * The session's OWNER may always end it — no drive membership, no capability.
 * Ending is release-of-compute: an owner who just lost `canRunCode` (flag
 * flipped, admin role revoked) or was removed from the drive must still be
 * able to stop paying for their Sprite, or it bills until an operator
 * notices.
 *
 * NON-owners get the surface decision PLUS the real capability gate PLUS
 * drive delete authority. The first previous shape pinned `canRunCode: true`
 * on the fallthrough, handing every accepted drive member the power to
 * destroy other members' sessions (review finding H3); then, once
 * `canRunCode` widened from admin-only to every edit-access member
 * (review #2326), the capability alone stopped implying delete authority —
 * centralized drive-root permissions give non-admin members
 * `canDelete: false`, so an ordinary member must not tear down another
 * member's Sprite, filesystem, and live shells (codex round 12). Ending
 * someone ELSE's session is therefore owner-of-drive/admin territory, and
 * still capability-gated on top.
 */
export function decideAgentSessionEndAccess(
  input: DecideAgentSessionEndAccessInput,
): AgentSessionAccessDecision {
  if (input.requesterId.length > 0 && input.requesterId === input.session.ownerId) {
    return { allowed: true };
  }
  const surface = decideAgentSessionAccess(input);
  if (!surface.allowed) return surface;
  if (input.driveMembership !== 'owner' && input.driveMembership !== 'admin') {
    return { allowed: false, reason: 'delete_authority_required' };
  }
  if (!input.canRunCode) {
    return { allowed: false, reason: 'code_execution_denied' };
  }
  return { allowed: true };
}
