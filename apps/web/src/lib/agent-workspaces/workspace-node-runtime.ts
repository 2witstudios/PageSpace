/**
 * The node model's production wiring: THE read and THE write.
 *
 * Successor to the deleted `workspace-layout-runtime.ts`, and shorter for three reasons
 * that are all the same reason — the model underneath stopped having two of
 * everything.
 *
 *  * **The read is atomic.** `readWorkspaceNodes` returns `{rev, nodes}` from
 *    one statement (`readWorkspaceNodeSnapshots`), so the rev DESCRIBES the
 *    nodes rather than merely accompanying them. The pair the old snapshot read
 *    with `Promise.all([getWorkspaceGrid, currentRev])` could over-claim, and an
 *    over-claiming rev is not a cosmetic fault: the client adopts it as its
 *    base, and `applyRemoteUpdate`'s `payload.rev <= sync.rev` guard then drops
 *    the next real broadcast, leaving the client wrong until the next poll.
 *  * **There is no op memory.** The write primitive is an upsert of a node set,
 *    so a retried POST re-applies to the same state by construction; the
 *    `(workspaceId, opId)` row the verb path needed remembered something that
 *    can no longer happen.
 *  * **One shape serves one workspace and fifty.** The store's read takes a
 *    LIST, and the single case is that list with one element — so there is no
 *    second reader to keep in step with the first, and the sessions-list read is
 *    a wrapper rather than a second query.
 *
 * **What titles are, and where they live.** A node's `targetId` is whatever the
 * write that bound it supplied, so resolving a title without asking "may this
 * viewer see it" turns a layout read into a title oracle over every
 * conversation, shell and page in the system (security review HIGH 1). Titles
 * are therefore resolved and redacted ONCE PER VIEWER, and they ride BESIDE the
 * tree as `targets[]` rather than inside it — which is also what lets the
 * broadcast ship the whole tree to a room, since the tree is structural and
 * identical for every member while a title can only ever be part of an answer to
 * one caller.
 */

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaceShells, agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { pages } from '@pagespace/db/schema/core';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { redactConversationTitleForViewer } from '@pagespace/lib/agent-workspaces/redact-conversation-listing';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';
import { rootOf, type PaneTargetKind, type WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { destroy } from '@pagespace/lib/agent-workspaces/workspace-node-algebra';
import type {
  WireWorkspaceNode,
  WorkspaceNodeSnapshotResponse,
  WorkspaceNodeTarget,
} from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { decideNodeWrite } from '@pagespace/lib/agent-workspaces/workspace-node-write';
import { seedRoot } from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import type { CommandResult } from '@pagespace/lib/agent-workspaces/workspace-node-commands';
// `MembershipCode` already contains `CommandCode`, which contains
// `NodeOperationCode`, which contains `TreeViolationCode` — so naming the widest
// is what the client branch's `TreeViolationCode | … | CommandCode` was reaching
// for, minus the two imports that became redundant when membership arrived.
import type { MembershipCode, MembershipResult } from '@pagespace/lib/agent-workspaces/workspace-membership';
import {
  chatHeldElsewhereDetail,
  chatIndexRefusalDetail,
  conflictingChatTargets,
  isChatTargetUniqueViolation,
} from '@pagespace/lib/agent-workspaces/workspace-node-chat-binding';
import { removedChatTargets } from '@pagespace/lib/agent-workspaces/workspace-node-membership-diff';
import {
  awaitsBackfill,
  readChatTargetHolders,
  readConversationDirectoryRows,
  readDeletedChatTargets,
  readWorkspaceNodeSnapshot,
  readWorkspaceNodeSnapshots,
  withWorkspaceLock,
  writeWorkspaceNodes,
  type ConversationDirectoryRow,
  type DbExecutor,
  type WorkspaceNodeSnapshot,
} from '@pagespace/lib/services/agent-workspaces/workspace-node-store';
import { broadcastWorkspaceNodesUpdated } from '@/lib/websocket/agent-workspace-events';
import { conversationEvents } from '@/lib/websocket/conversation-events';
import { emitContextFromRow } from '@/lib/repositories/conversation-rev';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { announceWithoutUnsucceeding } from './close-conversation-in-workspace';
import { authorizePaneTargets, introducedPaneTargets, paneScopeDeps } from './authorize-pane-scope';

/**
 * Who a resolved target list is being derived FOR.
 *
 * `null` means NOBODY — no titles at all, which is the honest shape for the
 * server-side placement helpers: they discard the response entirely, so
 * resolving a title for them would be authority spent on nothing.
 */
export type TargetViewerId = string | null;

/**
 * THE READ. `{rev, nodes, targets}` for one workspace.
 *
 * Lock-free on purpose: the statement is its own snapshot, so a racing write
 * simply means this answer is a whole rev behind — which the rev reports, and
 * which the caller's next broadcast or poll closes. Taking the serializing lock
 * would make every sidebar poll queue behind every drag.
 */
export async function readWorkspaceNodes(
  workspaceId: string,
  viewerId: TargetViewerId,
): Promise<WorkspaceNodeSnapshotResponse> {
  const snapshot = await readWorkspaceNodeSnapshot(db, workspaceId);
  return {
    rev: snapshot.rev,
    nodes: snapshot.nodes,
    targets: await resolveTargets([{ workspaceId, nodes: snapshot.nodes }], viewerId, workspaceId),
  };
}

/**
 * MANY workspaces at once — THE SESSIONS-LIST READ.
 *
 * The consumer the previous phase was waiting for has arrived: the sidebar
 * renders the live tree out of the store, so the listing has to deliver one per
 * session. Underneath it is the same statement as the single read
 * (`readWorkspaceNodeSnapshots` — one query for one workspace and for fifty),
 * and the target resolution is one pass per KIND across every workspace at once,
 * authorized per workspace against its OWN owner. A shared listing therefore
 * cannot borrow the viewer's authority in their own workspace to unmask a title
 * in someone else's.
 *
 * Every workspace ASKED FOR gets an entry, including one that has never been
 * written — `{rev: 0, nodes: [], targets: []}`. "Never written" and "you did not
 * ask" have to stay different answers, because the client seats what it is given
 * and a missing entry would read as "keep whatever you had".
 */
export async function readWorkspaceNodesBulk(
  workspaceIds: readonly string[],
  viewerId: TargetViewerId,
): Promise<Map<string, WorkspaceNodeSnapshotResponse>> {
  const answer = new Map<string, WorkspaceNodeSnapshotResponse>();
  if (workspaceIds.length === 0) return answer;

  const snapshots = await readWorkspaceNodeSnapshots(db, [...workspaceIds]);
  const subjects = [...snapshots].map(([workspaceId, snapshot]) => ({ workspaceId, nodes: snapshot.nodes }));
  const targetsByWorkspace = await resolveTargetsByWorkspace(subjects, viewerId);

  for (const [workspaceId, snapshot] of snapshots) {
    answer.set(workspaceId, {
      rev: snapshot.rev,
      nodes: snapshot.nodes,
      targets: targetsByWorkspace.get(workspaceId) ?? [],
    });
  }
  return answer;
}

/**
 * The workspace's owner, or `null` when the row is not there.
 *
 * Takes the EXECUTOR it is given, so the write funnel can run it on the
 * transaction that already holds the lock rather than opening a second
 * connection while that lock is held. Fails closed: an owner that cannot be read
 * simply means the broadcast does not reach the owner's plane, never that it
 * reaches somebody else's.
 */
async function readWorkspaceOwnerId(executor: DbExecutor, workspaceId: string): Promise<string | null> {
  const rows = await executor
    .select({ ownerId: agentWorkspaces.ownerId })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}

/**
 * Announce `conversation:closed` for every thread a committed write removed
 * from its workspace — the directory plane's half of a membership change.
 *
 * Fire-and-forget in both directions a broadcast can fail. A rejected promise
 * is swallowed with a log, matching `emitConversationLifecycle`'s own policy;
 * a SYNCHRONOUS throw is caught by {@link announceWithoutUnsucceeding}, which
 * is the one that would otherwise matter — the write is already committed, so
 * letting it propagate would report a failure for something that happened, and
 * the retry would find the node gone and report "not there" a second time.
 * The sidebar's 120s backstop poll covers the announcement that never lands.
 */
function announceClosedConversations(rows: readonly ConversationDirectoryRow[]): void {
  for (const row of rows) {
    announceWithoutUnsucceeding(() => {
      void conversationEvents.closed(emitContextFromRow(row)).catch((error: unknown) => {
        loggers.api.warn('conversation lifecycle event emission failed', {
          conversationId: row.id,
          kind: 'closed',
          error: error instanceof Error ? error.message : 'unknown',
        });
      });
    });
  }
}

/**
 * Why a write was refused. Every one of these writes NOTHING.
 *
 * {@link MembershipCode} is the widest of the layered codes — it already
 * contains the commands', which contain the operations', which contain the
 * validator's — so naming it here is what keeps a refusal from being re-worded
 * on its way up. `bound_elsewhere` is the one code no layer can produce: it
 * comes from the table's global chat-target index, and only the database is in
 * a position to know.
 *
 * `awaiting_backfill` is the other code no layer below can produce, and it is
 * TEMPORARY BY CONSTRUCTION: it exists only while the old membership columns
 * are still in the schema, which is only until the follow-up migration drops
 * them. It refuses the first write to a workspace whose membership the backfill
 * has not moved yet — see `awaitsBackfill`, and the seed path in
 * `commitUnderLock` for why writing to such a workspace is unrecoverable.
 */
export type NodeWriteRefusal =
  | MembershipCode
  | 'foreign_scope'
  | 'forbidden_target'
  | 'bound_elsewhere'
  | 'awaiting_backfill'
  /** The write would show a conversation whose history has been deleted — see the liveness backstop in {@link commitUnderLock}. */
  | 'target_deleted'
  /** An end lost its race with an admission that reopened the session — see {@link destroyWorkspaceTree}'s `requireEnded`. */
  | 'session_reopened';

/**
 * What the write answers.
 *
 * `stale`, `conflict` and `ok` all carry the SNAPSHOT, and that is the whole
 * distinction between them and `refused`: a caller holding an optimistic edit
 * that no longer applies needs the tree to rebase onto, and a caller that sent
 * an impossible payload needs a code and nothing else. `conflict` is the second
 * kind of "your edit does not apply" — not because your rev moved, but because
 * the thing you tried to show is already shown somewhere the write path can see
 * and you cannot. It answers 409 for exactly that reason.
 */
export type ApplyWorkspaceNodeWriteResult =
  | { status: 'ok'; snapshot: WorkspaceNodeSnapshotResponse; changed: boolean }
  | { status: 'stale'; snapshot: WorkspaceNodeSnapshotResponse }
  | {
      status: 'conflict';
      /**
       * The algebra's own word for this fault, reused rather than re-coined:
       * `target_already_shown` is already what an operation answers when the
       * conversation the caller named is on another node. One fault, one code,
       * however the write path arrived at it.
       */
      code: 'target_already_shown';
      detail: string;
      snapshot: WorkspaceNodeSnapshotResponse;
    }
  | { status: 'refused'; code: NodeWriteRefusal; detail: string };

/**
 * What a caller wants written, decided against the tree the LOCK read.
 *
 * Two producers exist and they differ in exactly one way. A browser arrives
 * holding a tree it already reduced, so it sends nodes and a `baseRev` and the
 * rev check decides whether its arithmetic still applies. An agent arrives
 * holding nothing — it names a COMMAND ("show me this page"), the server
 * resolves it against the tree it is looking at, and there is no `baseRev`
 * because there is no stale snapshot to hold: `baseRev` is `rev`, always, and
 * the rebase loop the placement helpers used to run disappears with it.
 */
type WriteProducer = (
  nodes: readonly WorkspaceNode[],
  rev: number,
) =>
  | { status: 'write'; baseRev: number; put: readonly WireWorkspaceNode[]; drop: readonly string[] }
  | { status: 'refused'; code: NodeWriteRefusal; detail: string };

/**
 * WORK THAT MUST LAND IN THE SAME TRANSACTION AS THE NODE WRITE.
 *
 * The membership chokepoint's whole reason for existing. A conversation row and
 * the node that makes it a member of a workspace are one fact, so they are one
 * transaction: if the row lands and the node does not, the thread is a member of
 * nothing and appears nowhere — which is the ghost this epic deletes, measured
 * in production as workspaces holding threads they could not show.
 *
 * It receives the transaction, so everything it does must go through THAT
 * executor: a query on the pooled `db` from in here is a second connection and
 * is therefore outside the atomicity this type exists to provide (and, on a
 * small pool, a deadlock — see `withSessionListingLock`'s own doc).
 *
 * **A throw is the refusal.** The transaction rolls back, taking the node write
 * with it, and the error reaches the caller unchanged — which is what lets the
 * conversation layer keep its own error vocabulary instead of flattening every
 * failure into a layout code.
 *
 * **It runs BEFORE the binding gate, not after** — see the ordering comment at
 * the call site, which is load-bearing in both directions. That also makes this
 * the place to put a PRECONDITION that has to be read under the lock:
 * `destroyWorkspaceTree`'s `requireEnded` throws from here, and throwing before
 * the gate means the transaction unwinds having touched nothing at all.
 */
export type WithinNodeWrite = (tx: DbExecutor) => Promise<void>;

/**
 * A refusal that has to UNWIND rather than return, because `within` has already
 * written into the transaction by the time it is raised.
 *
 * Private to this module and never seen by a caller: `commitUnderLock` catches
 * it on the way out of the rollback and re-forms it as the ordinary
 * `{status: 'refused'}` answer. It exists so that "refused" and "wrote nothing"
 * stay the same sentence at every point in the funnel.
 */
/**
 * A conflict raised from INSIDE the transaction, so the rollback unwinds
 * whatever `within` wrote before it is re-formed as the caller's answer.
 *
 * Separate from `NodeWriteRefused` because the two answer differently: a
 * refusal is a 400-shaped "you cannot do that", a conflict is a 409 carrying
 * the snapshot the client rebases from. Folding them together would cost the
 * client its rebase body, which is the entire point of the conflict path.
 */
class NodeWriteConflicted extends Error {
  constructor(
    readonly detail: string,
    readonly snapshot: { rev: number; nodes: WorkspaceNode[] },
  ) {
    super('target_already_shown');
    this.name = 'NodeWriteConflicted';
  }
}

class NodeWriteRefused extends Error {
  constructor(
    readonly code: NodeWriteRefusal,
    readonly detail: string,
  ) {
    super(code);
    this.name = 'NodeWriteRefused';
  }
}

/**
 * THE ONE WRITE FUNNEL — lock, read, decide, gate, persist, broadcast.
 *
 * The whole read-decide-persist cycle is inside `withWorkspaceLock`,
 * because the lock closes a lost update only if the read that DECIDED the write
 * is in the same scope as the write itself. It is deliberately the same advisory
 * lock the legacy verb path takes, so during the migration window a node write
 * and a verb write for one workspace serialize against each other.
 *
 * **Nothing is repaired.** An invalid result is a refusal that writes nothing —
 * no re-parenting, no dropping of the offending node, no attaching a dangling
 * child to the root. A caller holding a stale snapshot is told to rebase; a
 * caller holding a broken one is told what broke.
 */
async function commitUnderLock(input: {
  workspaceId: string;
  /** Whose authority binds a NEW target. Always the acting HUMAN, never a model's word. */
  actingUserId: string;
  /** Who the answer's titles are for; `null` resolves none, for callers that discard the body. */
  viewerId: TargetViewerId;
  produce: WriteProducer;
  /** See {@link WithinNodeWrite}. Runs once the write is DECIDED, before the gate and before it is persisted. */
  within?: WithinNodeWrite;
  /**
   * Mint the root when the workspace has none, before the producer runs.
   * Defaults to TRUE, which is what every command needs: it has to have a root
   * to place into, and the alternative is the create-then-attach shape this
   * model deletes.
   *
   * {@link destroyWorkspaceTree} passes FALSE, and it is the only caller that
   * does. Ending a session is `destroy(rootId)`, so seeding first would mint a
   * root for the express purpose of destroying it — and the write that came out
   * would carry the seed in `put` and its id in `drop`, which the decision
   * resolves as "put wins" and lands as a freshly CREATED root on a workspace
   * that was just ended.
   */
  seed?: boolean;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, actingUserId, viewerId, produce, within } = input;
  const seedIfMissing = input.seed ?? true;

  /**
   * The chat targets this write tried to introduce, kept where the BACKSTOP can
   * read them. It only ever learns that the index refused a statement, never
   * which row won, so these ids are the best account it can give of what the
   * write was reaching for. Empty is a real answer, not a missing one — see
   * `chatIndexRefusalDetail`.
   */
  let attemptedChatBindings: readonly string[] = [];

  const commit = () =>
    withWorkspaceLock(workspaceId, async (tx) => {
    const before = await readWorkspaceNodeSnapshot(tx, workspaceId);

    // THE WORKSPACE'S BIRTH, folded into the first write that needs it. A
    // workspace row can exist with no node rows (a fresh spawn, or one the
    // backfill has not reached), and every command needs a root to place into.
    // The browser used to fill that gap with an `ensure` verb on mount — the
    // create-then-attach shape this model exists to delete. See `seedRoot`.
    //
    // The producer is handed the tree WITH the root, so a command resolves
    // against what will actually be stored; the seed itself rides in `put`
    // ahead of the caller's nodes, so a pane parented to it is never
    // `dangling_parent`. Its id is derived from the workspace, so two clients
    // racing to seed produce the identical write and converge on the upsert.
    /*
     * THE UN-BACKFILLED REFUSAL, and it sits here because here is the only
     * place the damage can happen.
     *
     * This release ships `0255` (the node tables) but NOT the drop of the old
     * membership columns — those stage separately, after the backfill runs, and
     * the reason is in the migration's own thread. In the window between the two
     * a database can hold real membership that only the old model records.
     *
     * Reading such a workspace shows it empty, which is recoverable: the
     * backfill fills it in. WRITING to it is not. The backfill skips any
     * workspace that has already been through the node model — it reads the
     * same `agent_workspace_node_revs` marker `awaitsBackfill` does, and this
     * write would mint one — so the root this line is about to seed would strand
     * that workspace's real membership permanently, and it would be counted
     * `alreadyMigrated`, so the census gating the rollout would call the run
     * clean. Silent, irreversible, and invisible to its own gate.
     *
     * So the seed refuses, loudly, instead. Only on the seed path: a workspace
     * that already has a tree is either backfilled or was always node-native,
     * and neither can be stranded by a further write.
     */
    if (seedIfMissing && rootOf(before.nodes) === undefined) {
      if (await awaitsBackfill(tx, workspaceId)) {
        return {
          kind: 'refused' as const,
          code: 'awaiting_backfill' as const,
          detail:
            'this workspace still holds membership that only the previous model records; ' +
            'run scripts/backfill-agent-workspace-nodes.ts before writing to it',
        };
      }
    }

    const { nodes: seatedNodes, seed } = seedIfMissing
      ? seedRoot(before.nodes, workspaceId)
      : { nodes: before.nodes, seed: null };

    const wanted = produce(seatedNodes, before.rev);
    if (wanted.status === 'refused') {
      return { kind: 'refused' as const, code: wanted.code, detail: wanted.detail };
    }

    const decision = decideNodeWrite({
      workspaceId,
      rev: before.rev,
      nodes: before.nodes,
      baseRev: wanted.baseRev,
      put: seed === null ? wanted.put : [seed, ...wanted.put],
      drop: wanted.drop,
    });

    if (decision.status === 'foreign_scope') {
      return { kind: 'refused' as const, code: 'foreign_scope' as const, detail: decision.detail };
    }
    if (decision.status === 'stale') return { kind: 'stale' as const, snapshot: before };
    if (decision.status === 'invalid') {
      return { kind: 'refused' as const, code: decision.code, detail: decision.detail };
    }

    // THE SHARED TRANSACTION, and it runs BEFORE the gate and before the change
    // check. Both orderings are deliberate:
    //
    //  * **Before the gate**, because the gate asks whether the acting user may
    //    bind this target, and for a membership write the target is a
    //    conversation THIS TRANSACTION is creating. A gate reading the pooled
    //    connection cannot see an uncommitted insert, so running it first would
    //    refuse every legitimate spawn — the gate is therefore run against `tx`,
    //    which means it has to run after the row it is asking about exists.
    //  * **Before the change check**, because a membership write whose node is
    //    already there is a no-op on the TREE and not necessarily a no-op on the
    //    row: a retried create still has to re-run its own idempotency gates (is
    //    this id really the conversation the caller described?), and skipping
    //    them because the layout happened not to move would answer "yes" to a
    //    request nobody checked.
    //
    // A throw from here rolls the whole transaction back — which is what makes
    // it impossible for a conversation to land without the node that makes it a
    // member of anything.
    if (within !== undefined) await within(tx);

    // SESSION ACCESS IS NOT TARGET ACCESS. Reaching this workspace says nothing
    // about the ids a node points at — they are free-form in the body, and for
    // an agent tool they came out of a MODEL. So the bindings this write
    // INTRODUCES are settled before anything is persisted, against the acting
    // user's own authority. Inside the lock, against the tree the lock read: see
    // `introducedPaneTargets` for why a lock-free pre-read would leave a race
    // whose payoff is the disclosure this gate exists to stop.
    const introduced = introducedPaneTargets(before.nodes, decision.persist.put);
    if (introduced.length > 0) {
      const allowed = await authorizePaneTargets(
        { viewerId: actingUserId, workspaceId, targets: introduced },
        // Bound to the TRANSACTION: the conversation or shell being introduced
        // may be one `within` just created, and containment against a row this
        // transaction cannot see would refuse the write that created it.
        paneScopeDeps(tx),
      );
      if (!allowed) {
        // THROWN, not returned, and this is the only refusal in this function
        // that is. Every refusal above happens before `within` has written
        // anything, so returning commits an empty transaction. This one happens
        // AFTER, so returning would commit `within`'s rows without the node
        // that makes them a member — the exact ghost this funnel exists to make
        // unrepresentable.
        throw new NodeWriteRefused('forbidden_target', 'You cannot show that in this workspace.');
      }
    }

    // THE GLOBAL BINDING, and it is a different question from the one above.
    // The ACL gate asks whether this caller may show that conversation; this
    // asks whether the TABLE will let anyone. `UNIQUE (targetId) WHERE
    // targetKind = 'chat'` carries no `rootId`, so a conversation held by a node
    // in ANOTHER workspace is invisible to `validateTree` — which sees one
    // workspace's list — and invisible to `authorizePaneScope`, which waves the
    // cross-workspace case through whenever the caller may access the thread on
    // its own footing. Without this the write reaches Postgres, the index
    // refuses it, and a domain refusal is answered as a 502 carrying nothing the
    // client can rebase on.
    //
    // AFTER the ACL gate, and the order is load-bearing. Reversed, a caller
    // could learn "that conversation is already shown somewhere" about a
    // conversation they have no authority over — an existence oracle, and the
    // exact disclosure the gate above exists to stop. The 403 has to win.
    //
    // Only CHAT: the index is predicated on the kind, and showing one page in
    // two panes is a thing users legitimately do.
    attemptedChatBindings = introduced.flatMap((target) =>
      target.kind === 'chat' && target.targetId !== null ? [target.targetId] : [],
    );
    if (attemptedChatBindings.length > 0) {
      const holders = await readChatTargetHolders(tx, attemptedChatBindings);
      const taken = conflictingChatTargets({ workspaceId, wanted: attemptedChatBindings, holders });
      if (taken.length > 0) {
        // THROWN, not returned — and that distinction is the whole bug this
        // replaces. A conflict discovered here has the same shape as
        // `forbidden_target` above: the write does not happen, and anything
        // `within` already wrote in this transaction must not survive it.
        // RETURNING committed those rows and reported success, because every
        // membership call site narrows away `refused` and `stale` and then
        // reads `.changed`, which a `conflict` does not carry — so it read
        // `undefined`, took the falsy branch, and answered "already a member"
        // for a conversation whose node was never written. That is the ghost
        // this epic exists to delete, produced by the epic's own code.
        // TypeScript said so at all three call sites; a package-scoped
        // typecheck is why nobody heard it.
        throw new NodeWriteConflicted(chatHeldElsewhereDetail(taken), before);
      }

      // THE LIVENESS BACKSTOP, and it is a third distinct question from the two
      // above: not "may this caller show it" and not "will the table let
      // anyone", but "is there still a thread here to show".
      //
      // Every admission path already asks it — `claim` refuses `!row.isActive`
      // as `not_found`, `reopen` as `history_deleted` — and every one of them
      // asks it OUTSIDE this transaction, on the pooled connection, before the
      // lock is taken. That is a read-then-act window, and a history-delete
      // fits inside it: `expelConversationFromSession` removes the node under
      // this lock and RELEASES it before `softDeleteConversation` flips
      // `isActive`, deliberately (the two cannot be one write without threading
      // an executor through message deactivation, room kicks and emits — see
      // that function's doc). In the gap the thread is homeless and still
      // active, so a concurrent claim passes its liveness read, admits it, and
      // the delete then lands on a conversation a node is holding.
      //
      // The result is a pane bound to a dead thread and a cap slot nobody can
      // reclaim — which is precisely the outcome expel-then-delete was ordered
      // to avoid, arrived at through concurrency instead of through a crash.
      // The order defends against the second and not the first.
      //
      // Asked HERE it needs no executor threading and no second lock, and it
      // closes the window rather than merely narrowing it — but ONLY because
      // the read takes `FOR SHARE` on the conversation row. A plain SELECT
      // takes no lock, and the delete's `UPDATE` would still be free to commit
      // between this read and this transaction's own commit, leaving a node
      // bound to a thread that had just died. With the row lock the two
      // serialize on the one object both sides touch, which no arrangement of
      // WORKSPACE locks could do — a claim may land in a workspace the delete
      // has never heard of. See `readDeletedChatTargets` for the lock mode and
      // the verification. Only INTRODUCED targets are
      // checked, so a resize or a move that re-sends an existing pane never
      // pays for it, and a pane whose thread died under it is not made
      // un-draggable by a write that binds nothing new.
      const dead = await readDeletedChatTargets(tx, attemptedChatBindings);
      if (dead.length > 0) {
        // THROWN for the same reason as the two refusals above it: `within` may
        // already have written, and those rows must not survive a write that
        // does not happen.
        throw new NodeWriteRefused(
          'target_deleted',
          `conversation(s) ${dead.join(', ')} no longer exist, so nothing can be shown for them`,
        );
      }
    }

    // A write that produces the tree already stored mints no rev, broadcasts
    // nothing, and announces nothing — which is what makes a retried POST
    // observably, and not merely structurally, a no-op. The empty `closed` here
    // is not a shortcut: a tree identical to the one stored removed nothing, so
    // the diff below would answer `[]` for it anyway.
    if (!decision.changed) {
      return { kind: 'ok' as const, snapshot: before, changed: false, ownerId: null, closed: [] };
    }

    const rev = await writeWorkspaceNodes(tx, { workspaceId, write: decision.persist });
    // The owner, read HERE — inside the transaction that already holds this
    // workspace's advisory lock and is already touching its tables — and not as
    // a second query on the hot path once the lock is released. The broadcast
    // needs it to reach the owner's own sessions room; see
    // `broadcastWorkspaceNodesUpdated` for why that room and no other.
    const ownerId = await readWorkspaceOwnerId(tx, workspaceId);
    // THE DIRECTORY PLANE'S HALF OF THIS WRITE, read here and emitted after the
    // commit (see the `outcome.changed` block below).
    //
    // Membership IS the node, so a chat node leaving the tree is the thread
    // leaving the workspace — and the sidebar's rows come from the LISTING, not
    // the tree, so `workspace:nodes-updated` cannot take one out of the listing
    // cache. Announcing from HERE rather than from the close route is what makes
    // the announcement a property of the write instead of a property of which
    // client happened to call which endpoint: a pane drop, the sidebar's row
    // drop, an agent tool's close and an end-session all pass through this
    // funnel, and only one of them ever went through the route that announced.
    //
    // `decision.nodes` is the FINAL tree, never `decision.persist.drop` — a
    // hand-off drops a target from one node and puts it on another in the same
    // write, and that must announce nothing. See `removedChatTargets`.
    const closed = await readConversationDirectoryRows(
      tx,
      removedChatTargets(before.nodes, decision.nodes),
    );
    return { kind: 'ok' as const, snapshot: { rev, nodes: decision.nodes }, changed: true, ownerId, closed };
  }).catch((error: unknown) => {
    // OUTSIDE the transaction body on purpose — this runs once the rollback has
    // ALREADY unwound. A refusal raised after `within` wrote cannot RETURN,
    // because returning commits `within`'s rows without the node that makes
    // them a member; it throws, the transaction unwinds, and it is re-formed
    // here as the ordinary answer. Folding this into a `try` inside the body
    // would catch it before the rollback and commit the exact ghost.
    //
    // Everything that is not a `NodeWriteRefused` keeps throwing — including
    // the chat-target index violation the BACKSTOP below is here to read.
    if (error instanceof NodeWriteConflicted) {
      return { kind: 'conflict' as const, snapshot: error.snapshot, detail: error.detail };
    }
    if (!(error instanceof NodeWriteRefused)) throw error;
    return { kind: 'refused' as const, code: error.code, detail: error.detail };
  });

  let outcome: Awaited<ReturnType<typeof commit>>;
  try {
    outcome = await commit();
  } catch (error) {
    // THE BACKSTOP, and it is not optional. The pre-flight above reads the table
    // and then writes, and nothing serializes those two steps against a writer
    // in a DIFFERENT workspace: the advisory lock is per workspace, and the two
    // callers racing for one conversation are in two of them by definition. A
    // pre-flight alone converts a rare 502 into a rarer 502.
    //
    // By CONSTRAINT NAME, never by widening to every unique violation — the
    // single-root index failing is a structurally broken workspace, and
    // answering that with "the conversation is shown elsewhere" would send a
    // client rebasing over a fault that has nothing to do with a conversation.
    // Anything else rethrows and the route answers 502, which is the honest code
    // for a fault the server cannot name.
    if (!isChatTargetUniqueViolation(error)) throw error;
    // The transaction rolled back, so the truth is whatever the winner left
    // behind — read fresh rather than reconstructed, which is also the newest
    // base the loser can rebase onto.
    return {
      status: 'conflict',
      code: 'target_already_shown',
      detail: chatIndexRefusalDetail(attemptedChatBindings),
      snapshot: await readWorkspaceNodes(workspaceId, viewerId),
    };
  }

  if (outcome.kind === 'refused') {
    return { status: 'refused', code: outcome.code, detail: outcome.detail };
  }

  // Titles resolve OUTSIDE the lock: they are derived display data, so a racing
  // rename just means this response carries the title from a moment ago — never
  // a reason to hold the per-workspace serializing lock over more IO.
  const snapshot = await withTargets(workspaceId, outcome.snapshot, viewerId);

  if (outcome.kind === 'stale') return { status: 'stale', snapshot };
  // Through the SAME resolution as `stale`, deliberately. The refusal answers
  // 409 with the rebase body, and a 409 that told a caller more (or less) than a
  // GET would tell them is a second read path to keep in step with the first.
  if (outcome.kind === 'conflict') {
    return { status: 'conflict', code: 'target_already_shown', detail: outcome.detail, snapshot };
  }

  if (outcome.changed) {
    // Structural only, and to TWO rooms — the workspace's own, and the owner's
    // directory plane. See the payload's own doc, including why there is not a
    // third.
    broadcastWorkspaceNodesUpdated({
      workspaceId,
      rev: outcome.snapshot.rev,
      nodes: outcome.snapshot.nodes,
      ownerId: outcome.ownerId,
    });
    // The DIRECTORY plane's `conversation:closed`, one per thread this write
    // took out of the workspace. Read inside the transaction (see above),
    // emitted only AFTER it committed and only when something changed — so a
    // replayed POST, which mints no rev and produces the tree already stored,
    // announces nothing, exactly as it broadcasts nothing. A rolled-back write
    // never reaches here at all: `outcome` is `refused` or `conflict`.
    announceClosedConversations(outcome.closed);
  }
  return { status: 'ok', snapshot, changed: outcome.changed };
}

/** THE ROUTE'S WRITE: a client-computed `{baseRev, put, drop}`. */
export async function applyWorkspaceNodeWrite(input: {
  workspaceId: string;
  baseRev: number;
  put: readonly WireWorkspaceNode[];
  drop: readonly string[];
  viewerId: string;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, baseRev, put, drop, viewerId } = input;
  return commitUnderLock({
    workspaceId,
    actingUserId: viewerId,
    viewerId,
    produce: () => ({ status: 'write', baseRev, put, drop }),
  });
}

/**
 * THE AGENT TOOLS' WRITE: a command the SERVER resolves against the tree it is
 * holding, inside the lock.
 *
 * **This is what retires the rebase loop.** The placement helpers used to read a
 * rev, compute a verb against it, POST, and retry up to three times while the
 * server answered `stale` — an optimistic-concurrency dance a server has no
 * reason to do with itself. A command resolved under the lock is decided against
 * the only tree that can still be there when it commits, so there is nothing to
 * rebase onto and no attempt budget to run out of.
 *
 * `run` gets the workspace's nodes and returns the command's compiled write, or
 * its refusal. Its operations are applied ATOMICALLY: `compile` returns one
 * write for all of them, and a refused step ends the command with no write at
 * all, so a caller either gets every edit or none.
 */
export async function applyWorkspaceNodeCommand(input: {
  workspaceId: string;
  /** The acting HUMAN. The ACL gate is theirs — never the model's word. */
  actingUserId: string;
  run: (nodes: readonly WorkspaceNode[]) => CommandResult;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, actingUserId, run } = input;
  return commitUnderLock({
    workspaceId,
    actingUserId,
    // Nothing reads the body: these callers report `changed` and discard the
    // rest, so resolving a title for them would be authority spent on nothing.
    viewerId: null,
    produce: (nodes, rev) => {
      const result = run(nodes);
      if (!result.ok) return { status: 'refused', code: result.code, detail: result.detail };
      return { status: 'write', baseRev: rev, put: result.write.put, drop: result.write.drop };
    },
  });
}

/**
 * END THE SESSION'S TREE: `destroy(rootId)`, and nothing else.
 *
 * **This is the top half of "one removal", wired.** The tree's own removal
 * operation is what ends a session — the same verb that closes a pane, pointed
 * at the root instead of at a leaf. There is no separate lifecycle verb here
 * and there must not be one, because two removals reconciled by convention is
 * the bug class this epic exists to delete.
 *
 * **It is a TREE operation and it stays one.** The sandbox teardown and the
 * row's lifecycle stamps are `endAgentSession`'s (`agent-workspaces.ts`), and
 * they are deliberately NOT folded into this transaction. Two reasons, and the
 * second is the load-bearing one:
 *
 *  - A Sprite is external to the database, so "transactional with the node
 *    write" is a distributed transaction wearing a local disguise. Threading an
 *    executor through the teardown path to get it would put a network call to
 *    the sandbox provider inside the workspace's advisory lock, so a slow or
 *    hanging teardown would block every layout write for that workspace.
 *  - It is not needed. A Sprite is keyed off the workspace id
 *    (`workspace-sprite-key.ts`), so an orphaned one is FINDABLE rather than
 *    lost: `endAgentSession` stamps `teardownRequestedAt` BEFORE it kills, and
 *    `sprite-orphan-reconcile.ts` reaps anything that carries that stamp without
 *    a confirmed kill. Referential integrity and an id-keyed reconciler already
 *    cover the gap a two-phase commit would have been buying.
 *
 * So the composition is an ORDER rather than a transaction, and `endSession`
 * owns it: lifecycle first, tree second. See its own doc for why that order and
 * not the reverse.
 *
 * Idempotent. A workspace with no root has no tree to destroy and writes
 * nothing, so a retried end is a no-op rather than an error.
 */
export async function destroyWorkspaceTree(input: {
  workspaceId: string;
  /** The acting HUMAN. Nothing new is bound here, so the gate has nothing to judge — but the funnel takes one. */
  actingUserId: string;
  /**
   * Destroy only while the workspace is STILL ENDED, checked inside this
   * write's own transaction. `endSession` passes true and is the only caller
   * that does — it is the half of the composition above that makes "lifecycle
   * first, tree second" safe against a concurrent admission.
   *
   * Without it the order has a window with a ghost in it. `endAgentSession`
   * stamps `endedAt` outside this lock, so between the stamp and this destroy
   * an admission can take the lock, write its node, and then clear `endedAt`
   * (`reopenEndedSessionListing` — new work in an ended session reopens its
   * listing, #2335). The destroy that follows then wipes a tree the reopen had
   * just legitimately populated, leaving a workspace that is LIVE, in the
   * sidebar, holding zero nodes, with a conversation that lost its only record
   * of membership — the exact zero-pane workspace this epic exists to delete,
   * produced by the epic's own end path.
   *
   * Re-reading the stamp under the lock linearizes the two: either the end is
   * still in force and the tree goes, or the admission got there first and the
   * end is stale, in which case the newer intent — a user putting work back
   * into this session — wins and the tree stands. The torn-down Sprite is not a
   * problem for the survivor; a reopened session re-provisions under the same
   * `spriteKey` on its next `ensure`, which is the same state a resumed session
   * is always in.
   */
  requireEnded?: boolean;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  return commitUnderLock({
    workspaceId: input.workspaceId,
    actingUserId: input.actingUserId,
    viewerId: null,
    ...(input.requireEnded === true
      ? {
          within: async (tx) => {
            const [row] = await tx
              .select({ endedAt: agentWorkspaces.endedAt })
              .from(agentWorkspaces)
              .where(eq(agentWorkspaces.id, input.workspaceId))
              .limit(1);
            // A row that vanished has no tree worth defending; the destroy is
            // idempotent and the FK would have taken the nodes anyway.
            if (row !== undefined && row.endedAt === null) {
              throw new NodeWriteRefused(
                'session_reopened',
                'this session was reopened after the end began; its tree belongs to the newer work',
              );
            }
          },
        }
      : {}),
    // See the flag's own doc: seeding here would mint a root in order to
    // destroy it, and the composed write would land as a CREATE.
    seed: false,
    produce: (nodes, rev) => {
      const root = rootOf(nodes);
      // Nothing to end. Not a refusal: the caller asked for a workspace with no
      // tree to hold no tree, which is the state it is in.
      if (root === undefined) return { status: 'write', baseRev: rev, put: [], drop: [] };
      const result = destroy(nodes, { nodeId: root.id });
      if (!result.ok) return { status: 'refused', code: result.code, detail: result.detail };
      return { status: 'write', baseRev: rev, put: result.write.put, drop: result.write.drop };
    },
  });
}

/**
 * THE MEMBERSHIP WRITE — a node that says a thread belongs to this workspace,
 * and (optionally) the row that thread IS, in one transaction.
 *
 * This is the chokepoint. `conversations.workspaceId` used to be membership and
 * a pane row used to be layout, written by two paths with nothing holding them
 * in correspondence; here membership has exactly one home and exactly one
 * writer. Everything that used to reconcile the two — claim, close, reopen, the
 * pane annotation — is a `create`, a `move` or a `destroy` through here.
 *
 * `within` is what closes the ghost case: a conversation whose row landed and
 * whose node did not. It runs inside the same transaction as the node write, so
 * either both are there or neither is. The transaction is also what makes the
 * table's global chat-target uniqueness usable as a gate rather than as a
 * post-hoc discovery — a second workspace admitting the same conversation is
 * refused by the index, and the conversation row it was creating goes back with
 * it.
 *
 * The cap is decided by `run` against the tree the lock read, so it can no
 * longer be a count racing the insert it guards.
 *
 * **The global chat-target index answers as `conflict`, not as a refusal.** This
 * function used to wrap the call in a `try/catch` that turned that index
 * violation into `{status: 'refused', code: 'bound_elsewhere'}`. That catch was
 * DEAD: `commitUnderLock`'s own backstop matches the same index and, unlike the
 * local check, unwraps the driver's `cause` chain — so it always won, and the
 * `bound_elsewhere` branch had never run since Drizzle began wrapping query
 * errors. Rather than restore a second detector that has to be kept in step
 * with the first, the answer is the one the funnel actually gives, and the
 * callers that want to report "that conversation already belongs to a
 * workspace" read `conflict` (see `admitConversationNode`).
 */
export async function applyWorkspaceMembershipWrite(input: {
  workspaceId: string;
  /** The acting HUMAN. The binding gate is theirs — never a model's word. */
  actingUserId: string;
  run: (nodes: readonly WorkspaceNode[]) => MembershipResult;
  within?: WithinNodeWrite;
}): Promise<ApplyWorkspaceNodeWriteResult> {
  const { workspaceId, actingUserId, run, within } = input;
  return commitUnderLock({
    workspaceId,
    actingUserId,
    // Nothing reads the body: membership callers report what happened and
    // discard the rest, so resolving a title for them would be authority
    // spent on nothing.
    viewerId: null,
    produce: (nodes, rev) => {
      const result = run(nodes);
      if (!result.ok) return { status: 'refused', code: result.code, detail: result.detail };
      return { status: 'write', baseRev: rev, put: result.write.put, drop: result.write.drop };
    },
    ...(within === undefined ? {} : { within }),
  });
}

async function withTargets(
  workspaceId: string,
  snapshot: WorkspaceNodeSnapshot,
  viewerId: TargetViewerId,
): Promise<WorkspaceNodeSnapshotResponse> {
  return {
    rev: snapshot.rev,
    nodes: snapshot.nodes,
    targets: await resolveTargets([{ workspaceId, nodes: snapshot.nodes }], viewerId, workspaceId),
  };
}

/** One workspace's nodes, for a resolution that may span several of them. */
interface TargetSubject {
  workspaceId: string;
  nodes: readonly WorkspaceNode[];
}

async function resolveTargets(
  subjects: readonly TargetSubject[],
  viewerId: TargetViewerId,
  workspaceId: string,
): Promise<WorkspaceNodeTarget[]> {
  const byWorkspace = await resolveTargetsByWorkspace(subjects, viewerId);
  return byWorkspace.get(workspaceId) ?? [];
}

/**
 * Bulk-resolve every bound node's target FOR ONE VIEWER, across any number of
 * workspaces at once — one query per kind however many workspaces are in play,
 * then one authorization pass per workspace.
 *
 * **A title is authority, so every kind has a gate** — the SAME three rules the
 * verb model's `resolvePaneLabels` applies, ported rather than re-derived:
 *
 *  - `chat` — the conversation must be genuinely IN the workspace whose tree
 *    this is, or be one the viewer may access on its own footing
 *    (`canAccessConversation`). Containment is the load-bearing half: without
 *    it, an attacker who binds a foreign conversation into a workspace they OWN
 *    passes the redaction rule's owner branch and reads the real title. What
 *    survives still goes through `redactConversationTitleForViewer`, the epic's
 *    ONE listing rule.
 *  - `terminal` — the shell must belong to THIS workspace. Shells are
 *    workspace-scoped rows, so containment is the whole rule.
 *  - `page` — the viewer must have page access. Pages are not workspace-scoped
 *    at all, so their own ACL is the only answer.
 *
 * A target that fails its gate — or no longer exists — simply has NO entry, so
 * refusing to resolve is indistinguishable from "gone" and the join is not an
 * existence oracle either. The NODE keeps its place in the tree regardless: a
 * pane whose title cannot be resolved still renders, exactly as it did when the
 * label came back empty.
 */
async function resolveTargetsByWorkspace(
  subjects: readonly TargetSubject[],
  viewerId: TargetViewerId,
): Promise<Map<string, WorkspaceNodeTarget[]>> {
  const empty = new Map<string, WorkspaceNodeTarget[]>();
  if (viewerId === null) {
    for (const subject of subjects) empty.set(subject.workspaceId, []);
    return empty;
  }

  const chatIds = new Set<string>();
  const shellIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const subject of subjects) {
    for (const node of subject.nodes) {
      if (node.nodeType !== 'pane' || node.target === null) continue;
      // Exhaustive on purpose: a new PaneTargetKind falling off the end of an
      // if/else chain would collect no ids, resolve no title, and render blank —
      // a silent hole rather than a build failure.
      switch (node.target.kind) {
        case 'chat':
          chatIds.add(node.target.id);
          break;
        case 'terminal':
          shellIds.add(node.target.id);
          break;
        case 'page':
          pageIds.add(node.target.id);
          break;
        default: {
          const _exhaustive: never = node.target.kind;
          void _exhaustive;
        }
      }
    }
  }

  const workspaceIds = subjects.map((subject) => subject.workspaceId);
  const [chatRows, shellRows, pageRows, workspaceRows] = await Promise.all([
    chatIds.size > 0
      ? db
          .select({
            id: conversations.id,
            title: conversations.title,
            type: conversations.type,
            contextId: conversations.contextId,
            userId: conversations.userId,
            isShared: conversations.isShared,
            // Read for `conversationPageId`, which needs a column of its own
            // for `type='client'` (whose `contextId` is a DRIVE). Selecting it
            // is what keeps this derivation the shared rule rather than the
            // page-only half of it.
            agentPageId: conversations.agentPageId,
            // NOT `conversations.workspaceId`. The client branch selected it
            // for the containment compare below; membership moved to the tree,
            // so containment is now `wanted.has('chat:…')` and the column has
            // no reader. Selecting a column this epic stopped writing would
            // read to the next maintainer as live membership evidence.
            // The ordering fact the sidebar needs once it stops reading
            // `session.conversations` — carried here rather than fetched a
            // second time, because it is authorized by exactly the gate the
            // title already passed.
            lastMessageAt: conversations.lastMessageAt,
          })
          .from(conversations)
          .where(inArray(conversations.id, [...chatIds]))
      : Promise.resolve([]),
    shellIds.size > 0
      ? db
          .select({
            id: agentWorkspaceShells.id,
            name: agentWorkspaceShells.name,
            workspaceId: agentWorkspaceShells.workspaceId,
          })
          .from(agentWorkspaceShells)
          .where(inArray(agentWorkspaceShells.id, [...shellIds]))
      : Promise.resolve([]),
    pageIds.size > 0
      ? db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, [...pageIds]))
      : Promise.resolve([]),
    workspaceIds.length > 0
      ? db
          .select({ id: agentWorkspaces.id, ownerId: agentWorkspaces.ownerId })
          .from(agentWorkspaces)
          .where(inArray(agentWorkspaces.id, workspaceIds))
      : Promise.resolve([]),
  ]);

  const [readablePages, accessibleConversations] = await Promise.all([
    resolveReadablePages(pageRows, viewerId),
    resolveAccessibleConversations(chatRows, viewerId),
  ]);

  const owners = new Map(workspaceRows.map((row) => [row.id, row.ownerId]));
  const resolved = new Map<string, WorkspaceNodeTarget[]>();
  for (const subject of subjects) {
    // An unknown owner never matches a viewer, so the redaction rule's owner
    // branch fails CLOSED on a workspace row that has vanished.
    const workspaceOwnerId = owners.get(subject.workspaceId) ?? '';
    // Only the targets this workspace's nodes actually point at: the queries
    // above span every subject at once, and a workspace must not learn a title
    // because some OTHER workspace in the same listing showed it.
    const wanted = new Set<string>();
    for (const node of subject.nodes) {
      if (node.nodeType === 'pane' && node.target !== null) wanted.add(`${node.target.kind}:${node.target.id}`);
    }
    const targets: WorkspaceNodeTarget[] = [];
    const push = (
      kind: PaneTargetKind,
      id: string,
      title: string,
      lastMessageAt: Date | null,
      agentPageId: string | null,
    ): void => {
      if (!wanted.has(`${kind}:${id}`)) return;
      targets.push({ id, kind, title, lastMessageAt: lastMessageAt?.toISOString() ?? null, agentPageId });
    };

    for (const row of chatRows) {
      // CONTAINMENT, and it has moved from a column compare to the tree itself.
      // Every chat id in `wanted` is one THIS subject's nodes point at, and a
      // node bound to a conversation IS that conversation's membership — so
      // `conversations.workspaceId === subject.workspaceId` and "this
      // workspace's tree holds it" are now the same sentence, and the second is
      // the one the model still has.
      //
      // This is the same gate moved EARLIER rather than a weakened one. A node
      // binding a conversation can only be written through
      // `authorizePaneTargets`, and for an INTRODUCED chat target containment
      // is false by definition (nothing holds it yet), so
      // `canAccessConversation` is what let it in. A conversation is therefore
      // in this tree because someone who could access it put it there — which
      // is exactly what the column used to attest, checked once at the write
      // instead of again at every read.
      const containedHere = wanted.has(`chat:${row.id}`);
      if (!containedHere && !accessibleConversations.has(row.id)) continue;
      const title = redactConversationTitleForViewer({
        viewerId,
        workspaceOwnerId,
        conversation: { ownerId: row.userId, isShared: row.isShared === true, title: row.title },
      });
      // Behind the SAME gate the title just passed — a target that fails it has
      // no entry at all, so this can never name the agent of a thread the
      // viewer could not otherwise name.
      push('chat', row.id, title ?? '', row.lastMessageAt, conversationPageId(row));
    }
    for (const row of shellRows) {
      if (row.workspaceId !== subject.workspaceId) continue;
      push('terminal', row.id, row.name, null, null);
    }
    for (const row of pageRows) {
      if (!readablePages.has(row.id)) continue;
      push('page', row.id, row.title, null, null);
    }

    resolved.set(subject.workspaceId, targets);
  }
  return resolved;
}

/** The subset of `pageRows` this viewer may actually read. */
async function resolveReadablePages(
  pageRows: ReadonlyArray<{ id: string }>,
  viewerId: string,
): Promise<Set<string>> {
  const decided = await Promise.all(
    pageRows.map(async (row) => ((await getUserAccessLevel(viewerId, row.id)) !== null ? row.id : null)),
  );
  return new Set(decided.filter((id): id is string => id !== null));
}

/**
 * The subset of `chatRows` this viewer may access on the conversation's OWN
 * footing. Routed through `canAccessConversation` — the SAME predicate the
 * `conv:` room join and `/stream-join` enforce — rather than a second copy of
 * the rule.
 */
async function resolveAccessibleConversations(
  chatRows: ReadonlyArray<{ id: string; userId: string; isShared: boolean | null; type: string; contextId: string | null }>,
  viewerId: string,
): Promise<Set<string>> {
  const decided = await Promise.all(
    chatRows.map(async (row) => {
      const allowed = await canAccessConversation(
        viewerId,
        { userId: row.userId, isShared: row.isShared === true, type: row.type, contextId: row.contextId },
        { getPageAccess: async (userId, pageId) => (await getUserAccessLevel(userId, pageId)) !== null },
      );
      return allowed ? row.id : null;
    }),
  );
  return new Set(decided.filter((id): id is string => id !== null));
}
