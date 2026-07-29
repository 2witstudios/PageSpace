/**
 * The IO wrapper around the ONE agent-session access decision.
 *
 * Its whole job is to GATHER — the session row, the requester's drive
 * membership, whether they may run code — and hand all three to
 * `decideAgentSessionAccess`. It contains no decision of its own, and that is
 * enforceable by reading it: the only `if`s below turn a null into another
 * null (there is no drive, so there is no membership to fetch; there is no
 * session, so there is nothing to decide about). Anything that WEIGHS these
 * facts belongs in the pure decider, where both enforcement points share it.
 *
 * Both enforcement points being one function is the concrete mitigation for the
 * "web and realtime must not diverge" risk: the API routes and the realtime
 * shell-connect handler call THIS, so a change to who may reach a session cannot
 * land on one surface and miss the other.
 */

import {
  decideAgentSessionAccess,
  decideAgentSessionEndAccess,
  type AgentSessionAccessDecision,
  type AgentSessionAccessSubject,
  type DriveMembership,
} from '../../agent-sessions/decide-session-access';

export interface AgentSessionAccessDeps {
  /** The session row, reduced to the three identity columns the decision needs. `null` = no such session. */
  findSession: (sessionId: string) => Promise<AgentSessionAccessSubject | null>;
  /**
   * The requester's relationship to the DRIVE. Called ONLY for a drive-scoped
   * session; a `null` answer (unresolved) denies — unknown is never a grant.
   */
  resolveDriveMembership: (input: {
    userId: string;
    driveId: string;
  }) => Promise<DriveMembership | null>;
  /** The centralized `canRunCode` capability check, already reduced to a boolean by the caller's wiring. Must never throw (it is fail-closed by construction). */
  canRunCode: (input: { userId: string; driveId: string | null }) => Promise<boolean>;
}

/**
 * The decision, widened with the one outcome the pure decider cannot express:
 * there is no such session to decide about. Kept OUT of the decider because a
 * missing row is a lookup fact, not an access rule — and because collapsing it
 * into a denial reason would make "denied" and "does not exist" indistinguishable
 * to callers that must answer 404 vs 403 differently.
 */
export type AgentSessionAccessCheck =
  | AgentSessionAccessDecision
  | { allowed: false; reason: 'session_not_found' };

export async function checkAgentSessionAccess({
  requesterId,
  sessionId,
  deps,
}: {
  requesterId: string;
  sessionId: string;
  deps: AgentSessionAccessDeps;
}): Promise<AgentSessionAccessCheck> {
  const session = await deps.findSession(sessionId);
  if (!session) return { allowed: false, reason: 'session_not_found' };

  const [driveMembership, canRunCode] = await Promise.all([
    // No drive means no membership to hold — a global-assistant session is
    // owner-only by construction, which the decider states and enforces.
    session.driveId === null
      ? Promise.resolve(null)
      : deps.resolveDriveMembership({ userId: requesterId, driveId: session.driveId }),
    deps.canRunCode({ userId: requesterId, driveId: session.driveId }),
  ]);

  return decideAgentSessionAccess({ requesterId, session, driveMembership, canRunCode });
}

/**
 * The END-SESSION gather, wrapping {@link decideAgentSessionEndAccess}: the
 * scope facts only, because ending a session is release of compute and must
 * survive a lost `canRunCode` (see the pure decider's doc — the owner may also
 * end a session in a drive they were removed from). The `canRunCode` dep is
 * deliberately not in this function's `Pick` — an end check that could consult
 * it would be one refactor away from gating on it.
 */
export async function checkAgentSessionEndAccess({
  requesterId,
  sessionId,
  deps,
}: {
  requesterId: string;
  sessionId: string;
  deps: Omit<AgentSessionAccessDeps, 'canRunCode'>;
}): Promise<AgentSessionAccessCheck> {
  const session = await deps.findSession(sessionId);
  if (!session) return { allowed: false, reason: 'session_not_found' };

  const driveMembership =
    session.driveId === null
      ? null
      : await deps.resolveDriveMembership({ userId: requesterId, driveId: session.driveId });

  return decideAgentSessionEndAccess({ requesterId, session, driveMembership });
}
