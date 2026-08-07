/**
 * Create a conversation and land it in a session — composed from two
 * independent steps, not one bespoke binding-at-INSERT mechanism: (1) an
 * ordinary idempotent "insert if missing" (a plain, session-agnostic
 * conversation), then (2) `claimConversationInSessionWith` — the ONE place
 * `conversations.workspaceId` is ever written (see `claim-conversation-in-session.ts`
 * for the full binding contract; contract invariant 1: the binding is
 * write-once, never re-pointed — a bound thread moving to another session is
 * still a fork, never a rebind).
 *
 * This used to bind inline, inside each creator's own INSERT, specifically to
 * avoid ever needing an UPDATE of `workspaceId` (the old H1 fix: an
 * unconditional create-then-UPDATE let a caller re-point an EXISTING
 * conversation, including someone else's, at their own session). Composing
 * on top of the claim primitive keeps that property — claim's own
 * ownership + null-only gates make the same hijack impossible — while
 * deleting the bespoke cap-check-with-retry-exemption and idempotent-retry
 * comparison this file used to hand-roll: both are now just claim's own
 * gates (`already_in_session`, the cap check), reused instead of
 * reimplemented.
 *
 * Pure decision logic over injected creators, per the repo rule that
 * branching which decides lifecycle/addressing lives in a testable module —
 * `agent-sessions-runtime.ts` only wires the production deps.
 */

import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';
import {
  claimConversationInSessionWith,
  type ClaimConversationInSessionDeps,
} from './claim-conversation-in-session';

export class ConversationUnavailableError extends Error {
  /**
   * `cause` carries the underlying failure (a creator throwing, a claim
   * losing) for the server-side log at the tool boundary — the CALLER still
   * sees only the one generic message, so an id-guessing caller learns
   * nothing extra (issue #2335: the original error used to be dropped here,
   * leaving the denial undiagnosable).
   */
  constructor(options?: ErrorOptions) {
    super('conversation_unavailable', options);
    this.name = 'ConversationUnavailableError';
  }
}

/**
 * The session already holds `MAX_SESSION_CONVERSATIONS` active conversations.
 * This is the claim primitive's own cap check, surfacing here as a thrown
 * error so this module's callers keep the same `instanceof` mapping they
 * already had — the cap itself now lives in exactly one place
 * (`claim-conversation-in-session.ts`), not duplicated here.
 */
export class SessionFullError extends Error {
  constructor() {
    super('session_full');
    this.name = 'SessionFullError';
  }
}

/**
 * The agent page belongs to a different DRIVE than the session's own drive. A
 * drive-scoped session's sandbox tenant, payer and access decision all derive
 * from ITS drive, so hosting another drive's agent would execute that agent's
 * turns — and bill their runtime — inside a workspace its drive never admitted
 * (three reviewers converged on this: codex p58/p59 + review M6).
 *
 * A GLOBAL session (driveId null) is exempt from this gate: its tenant/payer
 * already resolve to the session's own owner regardless of which agent's
 * conversation runs inside it (`resolveSessionTenantId`/`resolveSessionPayerId`
 * key off the SESSION's driveId/ownerId, never the hosted agent's), and each
 * conversation-creation route independently checks the caller can view the
 * target agent page before this gate ever runs. So a global session may host
 * any accessible agent, not just assistant threads.
 */
export class AgentNotInSessionDriveError extends Error {
  constructor() {
    super('That agent belongs to a different drive than this session.');
    this.name = 'AgentNotInSessionDriveError';
  }
}

export interface CreateConversationInSessionDeps extends ClaimConversationInSessionDeps {
  /**
   * The page-conversation creator (squat-guarded, idempotent on
   * `conversationId`): `conversationRepository.createConversation`. Session-
   * agnostic — never writes `workspaceId`; that happens in the claim step below.
   */
  createPageConversation: (input: {
    conversationId: string;
    userId: string;
    agentPageId: string;
    title: string | null;
  }) => Promise<'created' | 'exists' | 'message_owner_conflict'>;
  /**
   * The global-conversation creator: `resolveOrCreateConversation`, also
   * session-agnostic. Throws on a foreign owner or a history-deleted
   * collision — treated as unavailability, whatever its class.
   */
  createGlobalConversation: (input: {
    conversationId: string;
    userId: string;
    title: string | null;
  }) => Promise<void>;
}

export async function createConversationInSessionWith(
  deps: CreateConversationInSessionDeps,
  {
    conversationId,
    userId,
    agentPageId,
    workspaceId,
    title = null,
  }: {
    conversationId: string;
    userId: string;
    /** null = a global-assistant conversation. */
    agentPageId: string | null;
    workspaceId: string;
    /** Display label written at birth (a spawned worker's name). Labels only — never an address. */
    title?: string | null;
  },
): Promise<void> {
  // Cheap, early exits before inserting ANYTHING — claim's own gates (below)
  // remain the ENFORCED backstop for the narrow race window between here and
  // the atomic claim; these just avoid leaving an ORPHANED SESSIONLESS ROW
  // behind for the common, non-racy case where the outcome is already
  // knowable up front. Creation and binding are decoupled on purpose (a
  // sessionless conversation is an ordinary state), but a doomed mint must
  // not still leave a blank conversation cluttering the caller's history on
  // every retry (review finding — chatgpt-codex-connector: P1).
  const sessionRow = await deps.findSession(workspaceId);
  if (sessionRow === null) throw new ConversationUnavailableError({ cause: new Error('session_not_found') });
  // No endedAt gate: an ended session is a valid target that REOPENS when a
  // claim lands in it (see claim-conversation-in-session.ts) — lifecycle
  // state never refuses a permitted create (issue #2335).
  if ((await deps.countActiveConversations(workspaceId)) >= MAX_SESSION_CONVERSATIONS) {
    // Exempt an idempotent retry of a conversation ALREADY bound HERE — a
    // retry mints nothing new, so the cap must not stand between a caller
    // and its own already-created, already-bound conversation. Mirrors
    // claim's own `already_in_session` idempotency, re-checked properly
    // (and enforced) by the claim call below regardless of this pre-check.
    const existing = await deps.findConversation(conversationId);
    const isRetryInThisSession = existing !== null && existing.workspaceId === workspaceId;
    if (!isRetryInThisSession) throw new SessionFullError();
  }

  if (agentPageId === null) {
    try {
      await deps.createGlobalConversation({ conversationId, userId, title });
    } catch (error) {
      // Foreign owner or a binding mismatch — one answer, because
      // distinguishing them would tell an id-guessing caller which it was.
      // The original error rides along as `cause` for the boundary's log.
      throw new ConversationUnavailableError({ cause: error });
    }
  } else {
    // Cheap, early cross-drive exit before inserting a page conversation for
    // a mismatched agent — reuses `sessionRow` fetched above. Claim's own
    // gate (below) is the ENFORCED check; this just avoids the insert in the
    // common case where the mismatch is already knowable up front. Fail-
    // closed on unresolved facts.
    const agentDriveId = await deps.findAgentDriveId(agentPageId);
    if (agentDriveId === null) throw new ConversationUnavailableError({ cause: new Error('agent_missing_or_trashed') });
    if (sessionRow.driveId !== null && sessionRow.driveId !== agentDriveId) {
      throw new AgentNotInSessionDriveError();
    }

    const outcome = await deps.createPageConversation({ conversationId, userId, agentPageId, title });
    if (outcome === 'message_owner_conflict') throw new ConversationUnavailableError({ cause: new Error('message_owner_conflict') });
    if (outcome === 'exists') {
      // The repository's existence check is by id ALONE — no contextId
      // filter — so an id collision with a conversation anchored to a
      // DIFFERENT agent must not silently fall through to claim (which has
      // no notion of "which agent the caller asked for", only whose row it
      // is and which drive it's in). Ownership and session-binding
      // mismatches are claim's own job, below; this is the one check unique
      // to "does this existing row even mean what the caller asked for".
      const row = await deps.findConversation(conversationId);
      if (row === null || row.type !== 'page' || row.contextId !== agentPageId) {
        throw new ConversationUnavailableError({ cause: new Error('id_collision_with_different_anchor') });
      }
    }
  }

  const claimed = await claimConversationInSessionWith(deps, { conversationId, userId, workspaceId });
  if (claimed === 'claimed' || claimed === 'already_in_session') return;
  if (claimed === 'session_full') throw new SessionFullError();
  if (claimed === 'cross_drive_denied') throw new AgentNotInSessionDriveError();
  // 'not_found' (foreign/inactive/already-bound-elsewhere row) collapses to
  // the same generic refusal — an id-guessing caller learns nothing either
  // way; the specific gate rides along as `cause` for the boundary's log.
  throw new ConversationUnavailableError({ cause: new Error(`claim_${claimed}`) });
}
