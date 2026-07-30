/**
 * The ONE agent-session access decision.
 *
 * Both enforcement points — the web API routes and the realtime shell-connect
 * handler — call this function. That is the concrete mitigation for the risk
 * that the two surfaces drift apart: they cannot, because there is only one
 * decision, and its input shape is constructible from either side (a requester
 * id, the session row's own identity columns, and two facts the caller looks
 * up: the requester's drive membership, and whether they may run code at all).
 *
 * A session is a DRIVE-LEVEL workspace (contract invariant 1), so access is
 * drive access. The old model gated on conversation ownership and agent-page
 * permission; both dissolved with the conflation — a session hosts many
 * conversations with many agents, so neither a single thread's sharing state
 * nor a single page's ACL can speak for it. The drive can, and does.
 *
 * Three gates, evaluated in a fixed order so a denial always names the FIRST
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
 *  3. **Capability** — `canRunCode` (app-admin + the CODE_EXECUTION flag,
 *     computed by the centralized checker). A distinct reason, because it is a
 *     distinct condition: the requester may legitimately reach this session
 *     and still not be allowed a sandbox.
 *
 * Everything fails closed: an unresolved membership (`null`) denies, and an
 * empty requester denies.
 */

/** The session columns the decision needs — no more, so both surfaces can build it from a single row read. */
export interface AgentSessionAccessSubject {
  /** The session's own id. */
  sessionId: string;
  ownerId: string;
  /** null = a global-assistant session: no drive, so no drive to derive access from. */
  driveId: string | null;
}

/**
 * What the caller determined about the requester's relationship to the DRIVE.
 * `null` = not resolved (denied — unknown is never a grant).
 */
export type DriveMembership = 'owner' | 'member' | 'none';

export type AgentSessionDenialReason =
  | 'invalid_requester'
  | 'drive_access_denied'
  | 'global_assistant_not_owner'
  | 'code_execution_denied';

export type AgentSessionAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentSessionDenialReason };

export interface DecideAgentSessionAccessInput {
  requesterId: string;
  session: AgentSessionAccessSubject;
  /** The requester's membership in `session.driveId`. Ignored (may be null) for a global-assistant session. */
  driveMembership: DriveMembership | null;
  canRunCode: boolean;
}

export function decideAgentSessionAccess({
  requesterId,
  session,
  driveMembership,
  canRunCode,
}: DecideAgentSessionAccessInput): AgentSessionAccessDecision {
  if (requesterId.length === 0) {
    return { allowed: false, reason: 'invalid_requester' };
  }

  const isOwner = requesterId === session.ownerId;

  if (session.driveId === null) {
    // A global-assistant session has no drive to share through — it stays
    // private to its owner.
    if (!isOwner) return { allowed: false, reason: 'global_assistant_not_owner' };
  } else if (driveMembership !== 'owner' && driveMembership !== 'member') {
    // Includes an unresolved membership (`null`): unknown is denied. Applies
    // to the session owner too — losing the drive loses its working contexts.
    return { allowed: false, reason: 'drive_access_denied' };
  }

  if (!canRunCode) {
    return { allowed: false, reason: 'code_execution_denied' };
  }

  return { allowed: true };
}

export type DecideAgentSessionEndAccessInput = DecideAgentSessionAccessInput;

/**
 * The END-SESSION variant: ONE deliberate widening, for the owner only.
 *
 * The session's OWNER may always end it — no drive membership, no capability.
 * Ending is release-of-compute: an owner who just lost `canRunCode` (flag
 * flipped, admin role revoked) or was removed from the drive must still be
 * able to stop paying for their Sprite, or it bills until an operator
 * notices.
 *
 * NON-owners get the full decision, real capability included. The previous
 * shape pinned `canRunCode: true` on the fallthrough, which handed every
 * accepted drive member — including ones with no code-execution rights at
 * all — the power to destroy other members' sessions and kill their live
 * shells (review finding H3). Release-of-compute is the OWNER's emergency
 * exit; a collaborator ending shared compute is ordinary session management
 * and is gated exactly like every other session action.
 */
export function decideAgentSessionEndAccess(
  input: DecideAgentSessionEndAccessInput,
): AgentSessionAccessDecision {
  if (input.requesterId.length > 0 && input.requesterId === input.session.ownerId) {
    return { allowed: true };
  }
  return decideAgentSessionAccess(input);
}
