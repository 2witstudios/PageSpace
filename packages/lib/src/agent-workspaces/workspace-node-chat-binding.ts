/**
 * THE ONE INVARIANT NO WORKSPACE CAN CHECK FROM ITS OWN ROWS.
 *
 * `agent_workspace_nodes_chat_target_idx` is `UNIQUE (targetId) WHERE
 * targetKind = 'chat'`. The key is `targetId` ALONE — there is no `rootId` in
 * it — so it is the only constraint on the node table whose scope is the whole
 * table rather than one workspace. Every other one (the compound primary key,
 * the composite self-FK, the single-root index) carries `rootId`, which is
 * exactly why `validateTree` can settle them: it is handed one workspace's node
 * list, and one workspace's node list is the whole domain of a rootId-scoped
 * key.
 *
 * It is NOT the whole domain of this one. A conversation bound in workspace A
 * is invisible to a validator looking at workspace B's list, and no amount of
 * care inside that function changes it — the missing fact is in the table, not
 * in the tree. `validateTree` is pure and runs on the client; asking it to do IO
 * would trade the property that makes it usable there for a check it still could
 * not make offline.
 *
 * So the global half lives at the write path, which is where the table is, and
 * it is stated in TWO places because one is not enough:
 *
 *  1. A PRE-FLIGHT — {@link conflictingChatTargets} over rows the write path
 *     reads before it persists. This is what turns the fault into a typed
 *     refusal carrying the truth to rebase against, which is the entire point:
 *     a client that applied optimistically needs `{rev, nodes, targets}` back or
 *     its phantom pane stays on screen.
 *  2. A BACKSTOP — {@link isChatTargetUniqueViolation} on the way out. The
 *     pre-flight has a TOCTOU window that no lock closes: the per-workspace
 *     advisory lock serializes writes to ONE workspace, and the two writers
 *     racing for one conversation are by definition in two different ones. A
 *     pre-flight alone would make the 502 rarer, not gone.
 *
 * **Narrow on purpose.** The detector matches ONE index by name. The single-root
 * index is a different fault with a different fix, and reporting it as "that
 * conversation is shown elsewhere" would send a client chasing a conversation
 * that has nothing to do with it. By NAME, and never by matching the driver's
 * message text: the message is prose Postgres is free to reword, the constraint
 * name is the identifier the migration created.
 *
 * The backfill already does this arbitration for historical rows
 * (`resolveChatClaims` in ./workspace-node-backfill.ts, fed by a query across
 * the whole table). This is the same fact asked at runtime.
 */

/**
 * The partial unique index this module is about, spelled exactly as
 * `agent-workspace-nodes.ts` creates it and as Postgres reports it in
 * `DatabaseError.constraint`.
 */
export const CHAT_TARGET_UNIQUE_INDEX = 'agent_workspace_nodes_chat_target_idx';

/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** A node that already holds a chat target, and the workspace holding it. */
export interface ChatTargetHolder {
  /** The workspace the holding node lives in. */
  rootId: string;
  /** The holding node's id. */
  nodeId: string;
  /** The conversation it is bound to. */
  targetId: string;
}

/**
 * Which of the chat targets a write WANTS to bind are already held by a node in
 * a DIFFERENT workspace.
 *
 * `holders` is whatever the table answered for `wanted` — deliberately
 * unfiltered by workspace at the query, so the rule that decides which rows
 * matter lives here in one readable line rather than inside a `where` clause.
 *
 * A holder in the SAME workspace is not a conflict this function reports, and
 * that is not leniency. Within one workspace the fault is already settled twice
 * over: `validateTree` refuses a resulting tree that shows one conversation
 * twice (`duplicate_chat_target`), and the store's delete-before-upsert ordering
 * is what keeps a conversation MOVING between two nodes from holding the index
 * twice mid-transaction. Reporting it here as well would give one fault two
 * codes.
 *
 * Answers in `wanted` order and never repeats an id, so the detail a caller
 * builds from it is stable across runs.
 */
export function conflictingChatTargets(input: {
  /** The workspace being written. */
  workspaceId: string;
  /** The conversation ids this write would newly bind. */
  wanted: readonly string[];
  /** Rows the table returned for those ids. */
  holders: readonly ChatTargetHolder[];
}): string[] {
  const { workspaceId, wanted, holders } = input;
  const heldElsewhere = new Set(
    holders.filter((holder) => holder.rootId !== workspaceId).map((holder) => holder.targetId),
  );
  const conflicting: string[] = [];
  const seen = new Set<string>();
  for (const targetId of wanted) {
    if (!heldElsewhere.has(targetId) || seen.has(targetId)) continue;
    seen.add(targetId);
    conflicting.push(targetId);
  }
  return conflicting;
}

/**
 * Is this the one-node-per-conversation index refusing a write?
 *
 * Walks the `cause` chain, because drizzle wraps the driver's `DatabaseError`
 * in a `DrizzleQueryError` and the SQLSTATE only ever lives on the innermost
 * link — the same walk `isUniqueViolation` in ../services/subdomain-allocation.ts
 * does, narrowed by constraint name.
 *
 * BOTH halves are required. `23505` alone is every unique index on the table,
 * and the single-root index failing is a structurally broken workspace, not a
 * conversation shown twice; answering the first with the second's code would be
 * a lie a client acts on.
 */
export function isChatTargetUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === CHAT_TARGET_UNIQUE_INDEX) {
    return true;
  }
  return isChatTargetUniqueViolation(candidate.cause);
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"` — for a sentence, not for a machine. */
function listed(ids: readonly string[]): string {
  const quoted = ids.map((id) => `"${id}"`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * What the PRE-FLIGHT says. It read the rows, so it knows the thing that is
 * true: these conversations are on a node somewhere else.
 *
 * It names the CONVERSATION and never the workspace holding it. The caller
 * supplied the conversation id, so repeating it discloses nothing; the other
 * workspace's id is a fact about a session this caller may have no business
 * knowing exists, and the refusal is no place to hand it over.
 */
export function chatHeldElsewhereDetail(conversationIds: readonly string[]): string {
  const subject =
    conversationIds.length === 0
      ? 'a conversation this write would show'
      : `conversation${conversationIds.length > 1 ? 's' : ''} ${listed(conversationIds)}`;
  const verb = conversationIds.length > 1 ? 'are' : 'is';
  return `${subject} ${verb} already shown in another workspace; a conversation renders in at most one pane`;
}

/**
 * What the BACKSTOP says, and it deliberately claims less.
 *
 * All this path knows is that the index refused the statement. It did not read
 * the winning row, so it cannot say WHERE the conversation is shown — and the
 * ids it does name are the ones the write was trying to introduce, which on the
 * losing side of a race is the right guess and is not a proof. Worded as the
 * fact rather than the cause so it stays true for every way the index can fire,
 * including a payload whose own `put` hands one conversation to a second node
 * within a single statement.
 *
 * The empty case is real, not defensive: such a payload introduces no NEW
 * binding at all (the workspace already held the conversation), so there is no
 * id to name.
 */
export function chatIndexRefusalDetail(conversationIds: readonly string[]): string {
  const subject =
    conversationIds.length === 0
      ? 'a conversation'
      : `conversation${conversationIds.length > 1 ? 's' : ''} ${listed(conversationIds)}`;
  return `the database refused this write: ${subject} cannot be shown by two nodes at once`;
}
