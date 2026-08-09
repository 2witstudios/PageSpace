/**
 * THE MEMBERSHIP CHOKEPOINT: create a conversation and make it a member of a
 * workspace — in ONE transaction, because they are one fact.
 *
 * **What changed, and why it is the whole point of this leaf.** This used to be
 * two independent steps: an ordinary "insert if missing" conversation, then a
 * claim that wrote `conversations.workspaceId`. Two steps means a window, and
 * the window is not hypothetical — it is the production symptom this epic
 * exists to delete. If the row landed and the binding did not, the thread was a
 * ghost: real history, member of nothing, visible nowhere. Placement was a THIRD
 * step, best-effort and after the lock, so a thread could also be a member of a
 * workspace that had no way to show it.
 *
 * Now the conversation row and the node that makes it a member are written by
 * one transaction (`within`, handed to the membership write). Either both are
 * there or neither is. There is no ordering to get right, no compensating
 * delete to forget, and no state where one exists without the other — which is
 * a property of the transaction rather than of anyone's diligence.
 *
 * **`placeInGrid` is gone entirely, and so is the `attach` flag that replaced
 * it.** Both chose whether the new thread would be on screen. `placeInGrid: false`
 * left it a member of nothing renderable; `attach: false` left it a member with
 * a node and no parent, which is the same problem wearing the model's own
 * clothes — a permanent population of parentless nodes, indistinguishable from
 * panes that lost their parent to a defect. Every admission is PLACED now, by
 * the same policy `openConversation` runs: it fills an unbound pane if there is
 * one, and splits rather than evicting if there is not. A caller with a pane
 * already waiting (the picker binds its own pane once the POST returns) is
 * served by exactly that rule — its waiting pane IS the unbound one, so the
 * placement lands there instead of minting a second beside it.
 *
 * **The cap is not here any more.** It is `admit`'s, decided against the tree
 * inside the same locked transaction that writes it. The pre-count this module
 * used to run — with a hand-rolled exemption for an idempotent retry — was a
 * number racing the insert it guarded, and its exemption is now simply the fact
 * that a thread the workspace already holds is not a newcomer.
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/addressing lives in a testable module —
 * `agent-workspaces-runtime.ts` only wires the production deps.
 */

import type { ClaimConversationInSessionDeps } from './claim-conversation-in-workspace';

export class ConversationUnavailableError extends Error {
  /**
   * `cause` carries the underlying failure (a creator throwing, an admission
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
 * The workspace already holds `MAX_SESSION_CONVERSATIONS` conversations.
 *
 * Raised from the membership write's own refusal, which counted the tree it was
 * about to write. This class stays so callers keep the `instanceof` mapping
 * they already had; the cap itself has no second home.
 */
export class SessionFullError extends Error {
  constructor() {
    super('session_full');
    this.name = 'SessionFullError';
  }
}

/**
 * The agent page belongs to a different DRIVE than the workspace's own drive. A
 * drive-scoped workspace's sandbox tenant, payer and access decision all derive
 * from ITS drive, so hosting another drive's agent would execute that agent's
 * turns — and bill their runtime — inside a workspace its drive never admitted
 * (three reviewers converged on this: codex p58/p59 + review M6).
 *
 * A GLOBAL workspace (driveId null) is exempt from this gate: its tenant/payer
 * already resolve to the workspace's own owner regardless of which agent's
 * conversation runs inside it (`resolveSessionTenantId`/`resolveSessionPayerId`
 * key off the WORKSPACE's driveId/ownerId, never the hosted agent's), and each
 * conversation-creation route independently checks the caller can view the
 * target agent page before this gate ever runs. So a global workspace may host
 * any accessible agent, not just assistant threads.
 */
export class AgentNotInSessionDriveError extends Error {
  constructor() {
    super('That agent belongs to a different drive than this session.');
    this.name = 'AgentNotInSessionDriveError';
  }
}

/**
 * The creators, and the executor they must run on.
 *
 * `Tx` is opaque here on purpose — this module never learns what a transaction
 * is, only that the same one has to carry both writes. The creators are
 * session-agnostic by construction: neither has a `workspaceId` parameter,
 * because after this change there is no conversation column for one to go in.
 */
export interface CreateConversationInSessionDeps<Tx = unknown>
  extends ClaimConversationInSessionDeps<Tx> {
  /**
   * The page-conversation creator (squat-guarded, idempotent on
   * `conversationId`): `conversationRepository.createConversation`.
   */
  createPageConversation: (
    input: { conversationId: string; userId: string; agentPageId: string; title: string | null },
    tx: Tx,
  ) => Promise<'created' | 'exists' | 'message_owner_conflict'>;
  /**
   * The global-conversation creator: `resolveOrCreateConversation`. Throws on a
   * foreign owner or a history-deleted collision — treated as unavailability,
   * whatever its class.
   */
  createGlobalConversation: (
    input: { conversationId: string; userId: string; title: string | null },
    tx: Tx,
  ) => Promise<void>;
  /**
   * The same row read as {@link ClaimConversationInSessionDeps.findConversation},
   * but on the TRANSACTION — the anchor check below has to see the row this
   * transaction just inserted, and a pooled read cannot.
   */
  findConversationIn: (
    conversationId: string,
    tx: Tx,
  ) => Promise<{ userId: string; type: string; contextId: string | null } | null>;
}

export async function createConversationInSessionWith<Tx>(
  deps: CreateConversationInSessionDeps<Tx>,
  {
    conversationId,
    userId,
    agentPageId,
    workspaceId,
    title = null,
    excludeTargetId,
  }: {
    conversationId: string;
    userId: string;
    /** null = a global-assistant conversation. */
    agentPageId: string | null;
    workspaceId: string;
    /** Display label written at birth (a spawned worker's name). Labels only — never an address. */
    title?: string | null;
    /** The spawning conversation, never evicted by the thing it spawned. */
    excludeTargetId?: string;
  },
): Promise<void> {
  // Cheap, early exits before opening a transaction. Unlike the version this
  // replaces, these are no longer racing the row they protect: nothing is
  // inserted unless the membership write commits, so a doomed mint cannot leave
  // an orphaned sessionless conversation behind however this read goes stale.
  // They exist to answer the ordinary case without taking the workspace's lock.
  const sessionRow = await deps.findSession(workspaceId);
  if (sessionRow === null) throw new ConversationUnavailableError({ cause: new Error('session_not_found') });
  // No endedAt gate: an ended workspace is a valid target that REOPENS when a
  // claim lands in it — lifecycle state never refuses a permitted create
  // (issue #2335).

  if (agentPageId !== null) {
    // The cross-drive rule, checked here as well as by the claim decision below
    // for the same reason it always was: it is the one refusal a caller can act
    // on, and reaching it before the transaction keeps the message specific.
    // Fail-closed on unresolved facts.
    const agentDriveId = await deps.findAgentDriveId(agentPageId);
    if (agentDriveId === null) throw new ConversationUnavailableError({ cause: new Error('agent_missing_or_trashed') });
    if (sessionRow.driveId !== null && sessionRow.driveId !== agentDriveId) {
      throw new AgentNotInSessionDriveError();
    }
  }

  const outcome = await deps.admitConversation({
    conversationId,
    workspaceId,
    ...(excludeTargetId === undefined ? {} : { excludeTargetId }),
    // THE SHARED TRANSACTION. Everything below runs on the same executor as the
    // node write, so a creator that throws takes the node with it and a node
    // the database refuses takes the conversation with it. Neither can outlive
    // the other, which is the entire contract of this module.
    within: async (tx) => {
      if (agentPageId === null) {
        try {
          await deps.createGlobalConversation({ conversationId, userId, title }, tx);
        } catch (error) {
          // Foreign owner or a binding mismatch — one answer, because
          // distinguishing them would tell an id-guessing caller which it was.
          // The original error rides along as `cause` for the boundary's log.
          throw new ConversationUnavailableError({ cause: error });
        }
        return;
      }

      const created = await deps.createPageConversation({ conversationId, userId, agentPageId, title }, tx);
      if (created === 'message_owner_conflict') {
        throw new ConversationUnavailableError({ cause: new Error('message_owner_conflict') });
      }
      if (created === 'exists') {
        // The repository's existence check is by id ALONE — no owner and no
        // contextId filter — so an id that resolves to SOMEONE ELSE'S thread,
        // or to one anchored to a DIFFERENT agent, must not silently fall
        // through into a membership write. This is the gate the old shape got
        // by composing on top of the claim primitive, which read the row and
        // refused a foreign owner before writing anything; the composition is
        // gone, so the gate is stated here.
        //
        // Read on the TRANSACTION, so a row this transaction inserted a moment
        // ago is visible to its own check — and so a concurrent insert that
        // won the squat guard's race is seen as it will be after commit.
        const row = await deps.findConversationIn(conversationId, tx);
        const mine = row !== null && row.userId === userId;
        if (!mine || row.type !== 'page' || row.contextId !== agentPageId) {
          throw new ConversationUnavailableError({ cause: new Error('id_collision_with_different_anchor') });
        }
      }
    },
  });

  if (outcome === 'admitted' || outcome === 'already_a_member') return;
  if (outcome === 'session_full') throw new SessionFullError();
  // Named in the `cause` rather than collapsed into the generic refusal below,
  // because this is the one outcome here that no caller and no retry can clear
  // — and the operator reading the boundary's log is the only person who can.
  // "The tree would not stand up" and "this database has not been migrated" are
  // not the same incident and must not share a log line.
  if (outcome === 'awaiting_backfill') {
    throw new ConversationUnavailableError({ cause: new Error('awaiting_backfill') });
  }
  // 'bound_elsewhere' (the unique index refused: this thread already has a
  // home) and 'refused' (the tree would not stand up) collapse to the same
  // generic refusal — an id-guessing caller learns nothing either way; the
  // specific reason rides along as `cause` for the boundary's log.
  throw new ConversationUnavailableError({ cause: new Error(`admit_${outcome}`) });
}
