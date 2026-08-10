/**
 * THE BACKFILL DERIVATION — legacy pane rows + membership → one canonical node
 * set per workspace, in ONE pass that emits EXACTLY ONE node per target.
 *
 * The pure half of `scripts/backfill-agent-workspace-nodes.ts`. All of it is
 * here and none of it is in the script, because this runs once over every real
 * workspace that exists and there is no second chance: a derivation that is
 * hard to test is a design failure, not an inconvenience.
 *
 * **Why one pass and not two.** The obvious shape is "migrate the layout tree,
 * then backfill the members that had no pane". It is wrong, and the way it is
 * wrong is unrecoverable. `agent_workspace_nodes` carries
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` — one conversation, one node,
 * GLOBALLY — and two passes each holding half the picture would both mint a
 * chat node for a conversation that has a pane, immediately before that index
 * starts depending on there being exactly one. De-duplicating afterwards is not
 * the same thing: it means the wrong state was representable and something had
 * to notice. Here every target is considered once, by one function, and the
 * "one node" property is a consequence of the control flow rather than of a
 * cleanup step.
 *
 * **The sources, and what each supplies.**
 *
 *     sources = (pane rows          → membership AND position)
 *             ∪ (open conversations → membership, no position: SEATED under the root)
 *             ∪ (shells             → membership, no position: SEATED under the root)
 *
 * A pane row is the only thing that carries a location. **Everything else is
 * PLACED anyway**, at the end of the root's own children — every member is in
 * the tree, and there is no second place for one to be. An earlier cut of this
 * derivation emitted those members with `parentId: null` and called it detached;
 * that reproduced, in the migration, the very split the migration exists to
 * remove, and it meant a workspace could arrive in the new model already holding
 * nodes no renderer would draw. Issue #2373 cannot recur here for the reason it
 * cannot recur anywhere else in this model: a member that is in a workspace is
 * in its tree.
 *
 * **What "open" means** is not this module's decision to make: it is
 * `countOpenConversations`' single predicate — bound to the workspace,
 * `isActive`, and `closedInWorkspaceAt IS NULL` — and the caller applies it
 * before handing rows over. A thread closed OUT of its session is deliberately
 * not a member; materialising it as a detached node would reopen, for every
 * user at once, every thread they ever dismissed.
 *
 * **AND THE SAME PREDICATE GOVERNS THE PANE ROWS**, which is the harder half
 * and was for a long time the missing one. Closing a thread out of a workspace
 * stamped `closedInWorkspaceAt` and **nothing on the server removed its pane
 * row**, so "a live pane bound to a dismissed thread" is not a corruption, it
 * is ordinary production data. Reading membership carefully and panes carelessly
 * would therefore have put every dismissed thread back — not merely in the
 * sidebar, which is what the membership path refuses, but ON THE GRID, which is
 * strictly worse. So a chat pane whose target is absent from
 * {@link DeriveOptions.openConversationIds} is **not materialised at all**: not
 * as a bound pane, and not as an unbound rectangle either, because an empty
 * picker sitting where a dismissed thread used to be is still a slot the user
 * did not ask for. Its siblings RENUMBER (`position` is assigned from the
 * sort's index and never copied), a column the removal empties disappears, and
 * a column it reduces to one collapses — all of which the derivation already
 * did for other reasons, so nothing new decides where the hole goes.
 *
 * **It refuses; it never re-homes.** Every node this emits carries the `rootId`
 * of the workspace it was derived FROM, asserted per node rather than assumed
 * from the loop. Nothing here ever moves a row into another workspace to
 * satisfy a constraint, and nothing here repairs an invalid derivation: a
 * workspace whose node set does not pass `validateTree` is REPORTED and
 * SKIPPED, and writing an invalid tree would be strictly worse, because a wrong
 * node set is somebody's panes in somebody else's session.
 *
 * **A SKIP IS NOT A SAFE OUTCOME, and it used to be described as one.** This
 * docblock said a skipped workspace was "left on the old tables, which still
 * work". That was true only inside the migration window: migration `0256` drops
 * the four layout tables and the two `conversations` membership columns
 * outright, so after cutover a skipped workspace has no grid and no membership
 * anywhere — it opens empty, and its threads, belonging to no node, read as
 * homeless and become claimable into a DIFFERENT workspace. The run's exit code
 * is the gate: `scripts/backfill-agent-workspace-nodes.ts` exits non-zero if a
 * single workspace is skipped, and `0256` must not be applied until it exits 0.
 */

import { FRACTION_EPSILON, readFraction } from './workspace-fractions';
import {
  nodesFromRows,
  rowFromNode,
  type WorkspaceNodeRow,
} from './workspace-node-rows';
import { rootSeedFor } from './workspace-node-commands';
import { validateTree, type TreeViolationCode } from './workspace-node-validate';
import type { PaneNode, PaneTargetKind, SplitNode, WorkspaceNode } from './workspace-node';

// ---------------------------------------------------------------------------
// The legacy rows, as they actually are
// ---------------------------------------------------------------------------

/** One row of `agent_workspace_pane_columns`, scoped to its workspace by the caller. */
export interface LegacyPaneColumn {
  id: string;
  orderIndex: number;
  widthFraction: number | null;
}

/**
 * One row of `agent_workspace_panes`.
 *
 * `kind` is typed `string | null` and NOT `PaneTargetKind | null` deliberately.
 * The column is untyped text with no check constraint behind it, so what a
 * reader gets is whatever a writer put there; narrowing it in the type would
 * make this module trust exactly the thing the new table's `targetKind` check
 * exists to stop trusting.
 */
export interface LegacyPane {
  id: string;
  columnId: string;
  orderIndex: number;
  kind: string | null;
  targetId: string | null;
  heightFraction: number | null;
}

/**
 * A member with no location: an open conversation, or a shell. `createdAt`
 * orders the parked list and nothing else — it is not a fact the node keeps.
 */
export interface LegacyMember {
  id: string;
  createdAt: Date;
}

/** Everything one workspace's derivation reads. */
export interface WorkspaceBackfillSource {
  workspaceId: string;
  columns: readonly LegacyPaneColumn[];
  panes: readonly LegacyPane[];
  /** OPEN conversations only — the caller applies `countOpenConversations`' predicate. */
  conversations: readonly LegacyMember[];
  shells: readonly LegacyMember[];
}

// ---------------------------------------------------------------------------
// The global chat claim
// ---------------------------------------------------------------------------

/** One place a chat node could be minted from a PANE row. */
export interface ChatPaneReference {
  workspaceId: string;
  conversationId: string;
}

/**
 * Decide, for every conversation a pane row points at, which workspace is
 * allowed to bind it — the one arbitration this migration cannot make locally.
 *
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` is GLOBAL, not per-workspace,
 * and a pane naming a conversation in another session is reachable today: the
 * old pane rows carry no such constraint, and the read path documents the case
 * ("a pane may name a conversation that is not in this workspace's listing — a
 * cross-workspace target the label resolver gates separately"). So a workspace
 * cannot know from its own rows whether it may bind a thread, and asking it to
 * guess is how one session's pane ends up owning another session's history.
 *
 * The priority is not a tie-break, it is the model's own rule restated:
 *
 *  1. **The owner wins, unconditionally.** `conversations.workspaceId` is
 *     write-once — "a thread's history and its filesystem always agree; moving
 *     a thread elsewhere is a FORK, never a rebind" — so if a live workspace
 *     will emit a membership node for this thread, that node IS the one node,
 *     and every pane elsewhere loses. Passing `membershipOwner` rather than
 *     inferring it keeps that fact where it is actually known.
 *  2. **Otherwise the lowest workspace id among the panes that name it.**
 *     Arbitrary, and deliberately so — with no owner in scope there is no
 *     principled winner, only a need for the SAME winner on every run.
 *  3. **Already claimed by an earlier run wins over both**, which is what makes
 *     a resumed migration continue rather than fight the index it half-filled.
 *
 * The loser is never re-homed and never dropped: its pane becomes UNBOUND and
 * renders the picker (see {@link deriveWorkspaceNodes}). Such a pane is already
 * broken today — the label resolver gates it, so it draws a nameless rectangle
 * — and an honest picker is a truer rendering of it than a binding that would
 * put one thread in two sessions each believing it owns the history.
 */
export function resolveChatClaims(params: {
  references: readonly ChatPaneReference[];
  /** conversationId → the live workspace that will emit a membership node for it. */
  membershipOwner: ReadonlyMap<string, string>;
  /** Chat targets an earlier run already bound. Nobody in this run may claim one. */
  claimed?: ReadonlySet<string>;
}): Map<string, string> {
  const { references, membershipOwner, claimed } = params;

  const byConversation = new Map<string, Set<string>>();
  for (const reference of references) {
    const workspaces = byConversation.get(reference.conversationId) ?? new Set<string>();
    workspaces.add(reference.workspaceId);
    byConversation.set(reference.conversationId, workspaces);
  }

  const claims = new Map<string, string>();
  for (const [conversationId, workspaces] of byConversation) {
    if (claimed?.has(conversationId)) continue;
    const owner = membershipOwner.get(conversationId);
    if (owner !== undefined) {
      claims.set(conversationId, owner);
      continue;
    }
    // Sorted rather than "first seen": row order out of Postgres is not a
    // promise, and a claim that depends on it would make a resumed run disagree
    // with the run it resumed.
    claims.set(conversationId, [...workspaces].sort()[0]);
  }

  // A membership owner with no pane anywhere never contends, but stating its
  // claim here means one map answers "who may bind this thread" for every
  // caller, instead of two rules that have to be remembered together.
  for (const [conversationId, owner] of membershipOwner) {
    if (claimed?.has(conversationId)) continue;
    claims.set(conversationId, owner);
  }

  return claims;
}

// ---------------------------------------------------------------------------
// What the derivation reports
// ---------------------------------------------------------------------------

/**
 * Something the derivation found in the real data and had to decide about.
 *
 * Every one of these is a WRITTEN workspace with an observation attached — a
 * workspace that could not be derived at all comes back as `skipped` instead.
 * They are separate because they need separate responses: a note is a fact
 * about production worth reading, a skip is a workspace somebody has to look at
 * before cutover.
 */
export type DerivationNoteCode =
  /** A column holding no panes. It renders nothing today and would be a `degenerate_split` tomorrow. */
  | 'empty_column_dropped'
  /** A column id that collided with an id already taken — legal in two tables, impossible in one. */
  | 'column_id_renamed'
  /**
   * A pane already held the id `rootSeedFor` mints for this workspace, so the
   * root took a suffixed one. Worth reporting rather than swallowing: the
   * derived id is what makes a client's seed and the server's the SAME write, so
   * a renamed root is a workspace that quietly does not have that property.
   */
  | 'root_id_renamed'
  /** `kind` without `targetId`, or the reverse. Half a binding is a corrupt pane, not a partial one. */
  | 'pane_target_half_bound'
  /** `kind` outside `'chat' | 'terminal' | 'page'`. The old column had no check constraint. */
  | 'pane_target_unknown_kind'
  /** Two panes of THIS workspace naming one conversation. First placement wins. */
  | 'chat_target_duplicated'
  /** A pane naming a conversation another workspace has the claim on. */
  | 'chat_target_foreign'
  /** A pane naming a conversation an earlier run already bound. */
  | 'chat_target_already_bound'
  /**
   * A pane naming a conversation row that does not exist, and no membership set
   * was supplied to judge it against. Carried — the binding has no FK by design.
   * With {@link DeriveOptions.openConversationIds} supplied, this pane is
   * `chat_pane_no_conversation` instead, and is dropped.
   */
  | 'chat_target_missing_row'
  /**
   * DROPPED: a pane bound to a conversation whose row is alive but which is no
   * longer a member — dismissed out of the workspace's listing
   * (`closedInWorkspaceAt`), or history-deleted (`isActive = false`).
   * Materialising it would put a thread the user closed back on their grid.
   */
  | 'chat_pane_not_a_member'
  /**
   * DROPPED: a pane bound to a conversation with no row at all, hard-deleted
   * with its page or drive. `expelConversationFromSession` is what removes such
   * a thread's node and it runs at DELETION time, so it will never run for
   * anything deleted before the cutover: the node would be a permanent member
   * holding a cap slot that nothing can ever release.
   */
  | 'chat_pane_no_conversation'
  /** An open conversation whose chat node exists elsewhere, so this workspace emits none. */
  | 'membership_claim_lost'
  /** A sibling group whose stored shares were mixed, non-positive or did not sum to 1. */
  | 'fractions_read_as_unsized';

export interface DerivationNote {
  code: DerivationNoteCode;
  /** The legacy row (or target) the note is about — the thing to go and look at. */
  subject: string;
  detail: string;
}

/**
 * The count sheet the rehearsal reads.
 *
 * The load-bearing line is `membersIn === paneNodesOut`. Every source that is a
 * member of the workspace becomes exactly one pane node; splits and the root
 * are structure this derivation invents, and are counted apart from it so they
 * can never pad the identity. A workspace where those two differ is a DEFECT —
 * a member either lost its node or grew a second one — not a rounding
 * difference, and the census test asserts it over every fixture.
 */
export interface WorkspaceCensus {
  workspaceId: string;
  columnsIn: number;
  /** Pane ROWS READ. Not the number materialised — see `panesDroppedNotMember`. */
  panesIn: number;
  conversationsIn: number;
  shellsIn: number;
  /**
   * Pane rows NOT materialised because the thread they show is not a member:
   * dismissed, history-deleted, or gone entirely.
   *
   * This is the number an operator has to see before an irreversible run, and
   * it is deliberately counted apart from `panesIn` rather than subtracted out
   * of it: `panesIn → panesIn - panesDroppedNotMember` is the difference
   * between what production holds and what the cutover keeps, and a census that
   * printed only the second number would show a clean migration of a workspace
   * that just lost half its grid.
   */
  panesDroppedNotMember: number;
  /**
   * MATERIALISED panes + conversations with no pane and a claim + shells with
   * no pane. Equals `paneNodesOut`.
   */
  membersIn: number;
  nodesOut: number;
  paneNodesOut: number;
  splitNodesOut: number;
  /**
   * Members that had no legacy pane row and were SEATED under the root.
   *
   * Was `detachedOut`, and the rename is the change: those members used to be
   * emitted with no parent at all, which is the state this correction deletes.
   * The number still matters for the rehearsal — it is how much of a workspace
   * the old layout could not account for — but what it counts is now nodes on
   * the grid rather than nodes beside it.
   */
  seatedOut: number;
  boundChatNodesOut: number;
  unboundPaneNodesOut: number;
  /** Open conversations that got no node here because their chat node lives elsewhere. */
  membershipDropped: number;
}

/** Why a workspace was left on the old tables. */
export interface DerivationSkip {
  /** A `validateTree` code, or one of this module's own three structural refusals. */
  code: TreeViolationCode | 'member_count_mismatch' | 'root_id_mismatch' | 'row_round_trip';
  detail: string;
}

export interface WorkspaceDerivation {
  workspaceId: string;
  /** The rows to INSERT. Empty when `skipped` is set — a skipped workspace writes nothing. */
  rows: WorkspaceNodeRow[];
  census: WorkspaceCensus;
  notes: DerivationNote[];
  skipped: DerivationSkip | null;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Hand out node ids that are unique within the workspace, preferring the ones
 * the legacy rows already carry.
 *
 * This exists because of a collision the old schema permits and the new one
 * cannot: column ids and pane ids are client-minted into two SEPARATE tables,
 * each with its own `(workspaceId, id)` primary key, so one workspace may
 * legitimately hold a column and a pane sharing an id. In the node model they
 * are rows of one table and that is a `duplicate_id` — a violation that would
 * make one of the two invisible to every `find` in the model.
 *
 * Preferring the original id is not cosmetic. Ids are client-minted precisely
 * so the browser can apply an edit optimistically without a round trip, and a
 * migration that renamed every pane would invalidate every id any client holds.
 * So renaming happens only on an actual collision, and the suffix is derived
 * from the id rather than from a counter over the whole workspace, so the same
 * input yields the same ids on a re-run.
 */
class NodeIdAllocator {
  private readonly taken = new Set<string>();

  /** Reserve an id verbatim. Panes go through here: they never yield to anyone. */
  reserve(id: string): string {
    this.taken.add(id);
    return id;
  }

  /** Take `preferred`, or the first `preferred#suffix`, `preferred#suffix2`, … that is free. */
  allocate(preferred: string, suffix: string): { id: string; renamed: boolean } {
    if (!this.taken.has(preferred)) {
      this.taken.add(preferred);
      return { id: preferred, renamed: false };
    }
    for (let attempt = 1; ; attempt += 1) {
      const candidate = `${preferred}#${suffix}${attempt === 1 ? '' : attempt}`;
      if (!this.taken.has(candidate)) {
        this.taken.add(candidate);
        return { id: candidate, renamed: true };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------

/**
 * A sibling group's shares, in the form the node model insists on: every member
 * sized, or every member unsized. Never mixed.
 *
 * Not a new rule — it is `rebalanceFractions`' stated invariant, applied to
 * stored rows instead of to a membership change: "wire input that arrives mixed
 * is read as UNSIZED wholesale rather than half-trusted, because a subset of
 * fractions summing to less than 1 has no defensible rendering." Every value
 * goes through `readFraction`, THE funnel every live reader already uses, so a
 * `0`, a negative or a NaN reads as unsized here exactly as it does in the grid
 * the user is looking at right now.
 *
 * A LONE member is always unsized, matching `rebalanceFractions` again: it owns
 * its whole container, so a stored share states nothing the structure does not
 * — and a container that looked sized would make the next arrival rebalance
 * against a number nobody chose.
 *
 * Returning all-null on a group that does not settle is what makes
 * `validateTree`'s `fraction_mixed` / `fraction_sum` unreachable BY
 * CONSTRUCTION rather than by luck. It is not a repair in the forbidden sense:
 * nothing moves, nothing is dropped, and the rendering is the one the current
 * read path already produces for that group.
 */
function settleGroupShares(raw: readonly (number | null)[]): (number | null)[] {
  const shares = raw.map(readFraction);
  if (shares.length < 2) return shares.map(() => null);
  if (shares.some((share) => share === null)) return shares.map(() => null);
  const total = shares.reduce((running: number, share) => running + (share ?? 0), 0);
  if (Math.abs(total - 1) >= FRACTION_EPSILON) return shares.map(() => null);
  return shares;
}

/** Whether {@link settleGroupShares} threw a group's stored shares away. */
function sharesWereDiscarded(raw: readonly (number | null)[], settled: readonly (number | null)[]): boolean {
  return raw.some((share, index) => readFraction(share) !== null && settled[index] === null);
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

const PANE_TARGET_KINDS: readonly string[] = ['chat', 'terminal', 'page'];

function isPaneTargetKind(kind: string): kind is PaneTargetKind {
  return PANE_TARGET_KINDS.includes(kind);
}

/** A pane row read as far as a single row can be: its binding, or nothing. */
interface ReadBinding {
  kind: PaneTargetKind;
  targetId: string;
}

/**
 * Read one pane row's binding, or `null` for unbound.
 *
 * Both halves move together or neither does. A row carrying one of them is not
 * a partially bound pane, it is a corrupt one, and there is no reading of it
 * that is better than the picker: a kind with no id shows nothing, and an id
 * with no kind names nothing. The same goes for a kind the closed domain does
 * not contain — the old column had no check constraint, so this is the first
 * place such a value can be caught, and carrying it forward would land it in a
 * column whose CHECK would refuse the whole insert.
 */
function readBinding(pane: LegacyPane): { binding: ReadBinding | null; note: DerivationNoteCode | null } {
  const kind = pane.kind;
  const targetId = pane.targetId !== null && pane.targetId.trim() !== '' ? pane.targetId : null;
  if (kind === null && targetId === null) return { binding: null, note: null };
  if (kind === null || targetId === null) return { binding: null, note: 'pane_target_half_bound' };
  if (!isPaneTargetKind(kind)) return { binding: null, note: 'pane_target_unknown_kind' };
  return { binding: { kind, targetId }, note: null };
}

/** A column and its panes, in render order, after the empty ones are gone. */
interface OrderedColumn {
  column: LegacyPaneColumn;
  panes: LegacyPane[];
}

/**
 * Order columns and their panes the way the grid renders them.
 *
 * `orderIndex` is supposed to be contiguous and 0-based, and mostly is — but a
 * verb that renumbered half a group and stopped would leave a gap, and this
 * derivation must not carry one into a model whose validator asserts
 * contiguity. So order is taken from the sort and `position` is assigned from
 * the sort's index, never copied. `id` breaks ties, so two rows that somehow
 * share an `orderIndex` still order the same way on every run.
 */
function orderColumns(
  columns: readonly LegacyPaneColumn[],
  panes: readonly LegacyPane[],
): OrderedColumn[] {
  const panesByColumn = new Map<string, LegacyPane[]>();
  for (const pane of panes) {
    const bucket = panesByColumn.get(pane.columnId) ?? [];
    bucket.push(pane);
    panesByColumn.set(pane.columnId, bucket);
  }
  return [...columns]
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id))
    .map((column) => ({
      column,
      panes: (panesByColumn.get(column.id) ?? []).sort(
        (left, right) => left.orderIndex - right.orderIndex || left.id.localeCompare(right.id),
      ),
    }));
}

/** A pane row the derivation refuses to materialise, and the reason to report. */
interface DroppedPane {
  pane: LegacyPane;
  code: 'chat_pane_not_a_member' | 'chat_pane_no_conversation';
  conversationId: string;
}

/**
 * Separate the pane rows that show a MEMBER from the ones that show a thread
 * nobody can reach any more.
 *
 * This runs BEFORE anything else reads `source.panes` — before ids are
 * reserved, before columns are ordered, before bindings are resolved — so
 * everything downstream sees a workspace in which the row simply does not
 * exist. That is what makes the consequences fall out of rules the derivation
 * already had rather than out of new ones: positions come from the sort's index
 * so the survivors renumber, an emptied column is dropped like any other empty
 * column, a column reduced to one pane collapses like any other single-pane
 * column, and a sibling group whose remaining shares no longer sum to 1 reads
 * as unsized. `validateTree`'s contiguity requirement is therefore met by
 * construction, and no hole is ever representable.
 *
 * Only CHAT panes can be dropped. Terminals and pages carry no membership —
 * opening the same page in two panes is a legitimate thing a user does — and a
 * half-bound or unknown-kind row never resolves to a chat binding in the first
 * place, so it survives as the picker pane it already renders as.
 */
function partitionPanesByMembership(
  panes: readonly LegacyPane[],
  openConversationIds: ReadonlySet<string> | undefined,
  knownConversationIds: ReadonlySet<string> | undefined,
): { kept: LegacyPane[]; dropped: DroppedPane[] } {
  // Nobody asked. Behave exactly as this derivation did before the predicate
  // existed — see `DeriveOptions.openConversationIds`.
  if (openConversationIds === undefined) return { kept: [...panes], dropped: [] };

  const kept: LegacyPane[] = [];
  const dropped: DroppedPane[] = [];
  for (const pane of panes) {
    const { binding } = readBinding(pane);
    if (binding === null || binding.kind !== 'chat' || openConversationIds.has(binding.targetId)) {
      kept.push(pane);
      continue;
    }
    dropped.push({
      pane,
      // Both are dropped for one reason — not a member — but an operator
      // reading the census needs them apart: a dismissal is a user's own past
      // decision being honoured, while a missing row is data the migration is
      // the last chance to notice.
      code:
        knownConversationIds === undefined || knownConversationIds.has(binding.targetId)
          ? 'chat_pane_not_a_member'
          : 'chat_pane_no_conversation',
      conversationId: binding.targetId,
    });
  }
  return { kept, dropped };
}

/** Parked members order oldest-first; `id` breaks ties so a re-run agrees with itself. */
function orderMembers(members: readonly LegacyMember[]): LegacyMember[] {
  return [...members].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
  );
}

export interface DeriveOptions {
  /**
   * conversationId → the workspace allowed to bind it, from
   * {@link resolveChatClaims}. A conversation absent from the map has no
   * competing reference anywhere and is claimed by whoever holds it.
   */
  chatClaims?: ReadonlyMap<string, string>;
  /** Chat targets an earlier run already bound. Nothing in this workspace may bind one. */
  claimedChatTargets?: ReadonlySet<string>;
  /** Conversation ids known to exist. Absence is reported, never acted on — the binding has no FK. */
  knownConversationIds?: ReadonlySet<string>;
  /**
   * THE MEMBERSHIP PREDICATE, resolved over every conversation any PANE row of
   * this batch names: `isActive` and `closedInWorkspaceAt IS NULL`.
   *
   * Spelled the same way as the `conversations` load the caller already
   * performs, and that is the entire point — the two loads used to disagree,
   * membership filtering carefully and panes not at all, which meant a thread
   * the user dismissed came back attached to the grid.
   *
   * This is the caller's fact to establish, not this module's: it needs the
   * `conversations` rows for targets that belong to OTHER workspaces, which a
   * per-workspace derivation never sees. **Absence of the option is not
   * "everything is open"** — it means "nobody asked", and the derivation then
   * behaves as it did before, carrying every pane. The one production caller,
   * `scripts/backfill-agent-workspace-nodes.ts`, always supplies it; a caller
   * that does not must not be used for a real migration.
   */
  openConversationIds?: ReadonlySet<string>;
}

/**
 * Derive one workspace's canonical node set. ONE pass, ONE node per target.
 *
 * The structure it produces:
 *
 *   * one `root` (`axis: 'row'` — the grid lays its columns out in a row);
 *   * each non-empty column a `split` under it (`axis: 'column'`), in order;
 *   * each pane a `pane` under its column, in order, carrying its binding;
 *   * **except** a column holding ONE pane, which collapses: the pane takes the
 *     column's place directly under the root, with the column's share. That is
 *     not a special case invented here — `validateTree` rejects a split holding
 *     fewer than two children as `degenerate_split`, and the algebra's
 *     `collapseInto` already resolves it the same way ("the survivor takes the
 *     split's PLACE: its parent, its slot and its share"). The old model
 *     allowed a one-pane column, so this is expected to be the COMMON shape,
 *     not an edge;
 *   * every member with no pane row a `pane` UNDER THE ROOT, after the columns,
 *     in the order it was created.
 */
export function deriveWorkspaceNodes(
  source: WorkspaceBackfillSource,
  options: DeriveOptions = {},
): WorkspaceDerivation {
  const { workspaceId } = source;
  const chatClaims = options.chatClaims ?? new Map<string, string>();
  const claimedChatTargets = options.claimedChatTargets ?? new Set<string>();
  const knownConversationIds = options.knownConversationIds;

  const notes: DerivationNote[] = [];
  const note = (code: DerivationNoteCode, subject: string, detail: string): void => {
    notes.push({ code, subject, detail });
  };

  // ---------------------------------------------------------------------
  // THE ROWS THAT SHOW A THREAD NOBODY IS A MEMBER OF — removed FIRST, so no
  // rule below ever sees them. This is answered before the claim rules on
  // purpose: a dismissed thread is not a thread another workspace owns, and
  // reporting it as `chat_target_foreign` would send an operator looking for a
  // contention that does not exist.
  // ---------------------------------------------------------------------
  const { kept: livePanes, dropped: droppedPanes } = partitionPanesByMembership(
    source.panes,
    options.openConversationIds,
    knownConversationIds,
  );
  for (const entry of droppedPanes) {
    note(
      entry.code,
      entry.pane.id,
      entry.code === 'chat_pane_not_a_member'
        ? `conversation "${entry.conversationId}" is not a member (dismissed, or history-deleted); the pane is not materialised`
        : `conversation "${entry.conversationId}" has no row at all; the pane is not materialised`,
    );
  }

  const ids = new NodeIdAllocator();
  // Panes first and verbatim: a pane id is the one a client holds and the one a
  // chat binding is addressed through, so it never yields to a column's. Only
  // the LIVE ones — a dropped row is not in this derivation, so it reserves
  // nothing and cannot rename a column that happens to share its id.
  for (const pane of livePanes) ids.reserve(pane.id);

  const ordered = orderColumns(source.columns, livePanes);
  const populated: OrderedColumn[] = [];
  for (const entry of ordered) {
    if (entry.panes.length === 0) {
      note(
        'empty_column_dropped',
        entry.column.id,
        `column holds no panes; it renders nothing today and would be a degenerate split`,
      );
      continue;
    }
    populated.push(entry);
  }

  // ---------------------------------------------------------------------
  // Bindings, resolved ONCE across the whole workspace.
  //
  // `boundChats` is the single-node-per-conversation property, made true by
  // construction: a conversation enters it at most once, and both the pane
  // path below and the membership path below read the SAME set. There is no
  // second pass that could disagree with the first about what is already
  // bound.
  // ---------------------------------------------------------------------
  const boundChats = new Set<string>();
  const bindings = new Map<string, ReadBinding | null>();
  const boundTerminals = new Set<string>();

  for (const entry of populated) {
    for (const pane of entry.panes) {
      const { binding, note: problem } = readBinding(pane);
      if (problem !== null) {
        note(
          problem,
          pane.id,
          `pane carries kind=${JSON.stringify(pane.kind)} targetId=${JSON.stringify(pane.targetId)}; read as unbound`,
        );
      }
      if (binding === null) {
        bindings.set(pane.id, null);
        continue;
      }

      if (binding.kind !== 'chat') {
        // Terminals and pages carry no uniqueness constraint, deliberately —
        // opening the same page in two panes is a legitimate thing a user does.
        if (binding.kind === 'terminal') boundTerminals.add(binding.targetId);
        bindings.set(pane.id, binding);
        continue;
      }

      const conversationId = binding.targetId;
      if (knownConversationIds !== undefined && !knownConversationIds.has(conversationId)) {
        // Reported, and then carried anyway. `targetKind`/`targetId` have no
        // foreign key by design — "a node pointing at a deleted conversation
        // repairs at read time" — and dropping the binding here would silently
        // change what the user sees for a row the model is built to tolerate.
        note('chat_target_missing_row', pane.id, `conversation "${conversationId}" has no row`);
      }
      if (claimedChatTargets.has(conversationId)) {
        note('chat_target_already_bound', pane.id, `conversation "${conversationId}" was bound by an earlier run`);
        bindings.set(pane.id, null);
        continue;
      }
      const claimant = chatClaims.get(conversationId);
      if (claimant !== undefined && claimant !== workspaceId) {
        note(
          'chat_target_foreign',
          pane.id,
          `conversation "${conversationId}" belongs to workspace "${claimant}"; this pane is read as unbound`,
        );
        bindings.set(pane.id, null);
        continue;
      }
      if (boundChats.has(conversationId)) {
        // FIRST placement wins, the rule the sidebar's own annotation already
        // uses. The loser keeps its rectangle and renders the picker: dropping
        // the pane would change the geometry the user arranged, and an unbound
        // pane is an ordinary state the model already spells.
        note('chat_target_duplicated', pane.id, `conversation "${conversationId}" is already shown by an earlier pane`);
        bindings.set(pane.id, null);
        continue;
      }
      boundChats.add(conversationId);
      bindings.set(pane.id, binding);
    }
  }

  // ---------------------------------------------------------------------
  // The nodes
  // ---------------------------------------------------------------------
  // THE SAME ROOT THE SEED WOULD MINT, from the same function, and that is the
  // point rather than a tidiness. `rootSeedFor` derives its id from the
  // workspace so that two writers racing to seed an empty tree produce the
  // IDENTICAL root and converge on the upsert. A backfill that minted its own
  // shape of id put a second derivation into circulation: a client seeding
  // against a stale or empty local tree while the server already held a
  // backfilled root would send a root the server does not have, and the write
  // would come back `multiple_roots` instead of converging. One derivation,
  // one root id.
  //
  // Still through the allocator, because a pane may already hold this id — the
  // old schema keys panes per-workspace and nothing stopped one being named
  // after its workspace. A renamed root loses the convergence above and keeps
  // the migration correct, which is the right way round.
  const seed = rootSeedFor(workspaceId);
  const allocatedRoot = ids.allocate(seed.id, 'root');
  if (allocatedRoot.renamed) {
    // REPORTED, not swallowed. Every other rename on this path emits a note, and
    // this one costs more than a name: the workspace keeps a correct tree but
    // loses the convergence the derived id exists to provide, and nothing else
    // in the run would say so.
    note(
      'root_id_renamed',
      workspaceId,
      `a pane already holds the id this workspace's root derives from; the root is "${allocatedRoot.id}"`,
    );
  }
  const rootId = allocatedRoot.id;
  const nodes: WorkspaceNode[] = [{ ...seed, id: rootId }];

  // ---------------------------------------------------------------------
  // THE MEMBERS THAT HAD NO PANE — resolved BEFORE anything is emitted, because
  // they are children of the root like the columns are and the root's shares
  // cannot be settled without knowing how many children it will have.
  //
  // They used to be emitted last and PARKED (`parentId: null`): in the
  // workspace, in the sidebar, not on screen. That was the whole of what
  // "detached" bought — a member the migration could not place — and it is
  // exactly the state that made a lost pane and a closed one look alike. Every
  // member is in the tree now, so a member with no pane row becomes a pane at
  // the end of the root's own children, which is where `readmit` used to put one
  // and where a user would look for it.
  // ---------------------------------------------------------------------
  interface SeatedMember {
    id: string;
    target: PaneNode['target'];
  }
  const seated: SeatedMember[] = [];
  let membershipDropped = 0;

  for (const conversation of orderMembers(source.conversations)) {
    if (boundChats.has(conversation.id)) continue; // Already on screen — one node, and it has it.
    if (claimedChatTargets.has(conversation.id)) {
      note(
        'membership_claim_lost',
        conversation.id,
        `an earlier run bound this conversation to a node elsewhere; no node is emitted here`,
      );
      membershipDropped += 1;
      continue;
    }
    const claimant = chatClaims.get(conversation.id);
    if (claimant !== undefined && claimant !== workspaceId) {
      note(
        'membership_claim_lost',
        conversation.id,
        `conversation is claimed by workspace "${claimant}"; no node is emitted here`,
      );
      membershipDropped += 1;
      continue;
    }
    boundChats.add(conversation.id);
    seated.push({
      id: ids.allocate(`${conversation.id}::pane`, 'chat').id,
      target: { kind: 'chat', id: conversation.id },
    });
  }

  for (const shell of orderMembers(source.shells)) {
    if (boundTerminals.has(shell.id)) continue;
    boundTerminals.add(shell.id);
    seated.push({
      id: ids.allocate(`${shell.id}::pane`, 'term').id,
      target: { kind: 'terminal', id: shell.id },
    });
  }

  // The root's group is the columns AND the newly seated members, so its shares
  // settle over both. A seated member carries no stored share — there was no
  // pane row to carry one — and `settleGroupShares` reads a group holding any
  // unsized member as unsized WHOLESALE, which is the rule it already applied to
  // a half-sized column. So a workspace with an unplaced member comes out with
  // an evenly divided root rather than a `fraction_mixed` refusal, and the note
  // below says the stored column widths were the thing given up.
  const rootRawShares = [
    ...populated.map((entry) => entry.column.widthFraction),
    ...seated.map(() => null),
  ];
  const rootShares = settleGroupShares(rootRawShares);
  if (sharesWereDiscarded(rootRawShares, rootShares)) {
    note('fractions_read_as_unsized', rootId, `the grid's column shares do not settle; read as unsized`);
  }

  populated.forEach((entry, position) => {
    const share = rootShares[position];
    const paneOf = (pane: LegacyPane, parentId: string, at: number, fraction: number | null): PaneNode => {
      const binding = bindings.get(pane.id) ?? null;
      return {
        nodeType: 'pane',
        id: pane.id,
        parentId,
        position: at,
        ...(fraction === null ? {} : { fraction }),
        target: binding === null ? null : { kind: binding.kind, id: binding.targetId },
      };
    };

    if (entry.panes.length === 1) {
      // The collapse. The survivor inherits the column's slot AND the column's
      // share — a `heightFraction` was a share of the column, and the column is
      // no longer there for it to be a share of.
      nodes.push(paneOf(entry.panes[0], rootId, position, share));
      return;
    }

    const allocated = ids.allocate(entry.column.id, 'split');
    if (allocated.renamed) {
      note(
        'column_id_renamed',
        entry.column.id,
        // Not "collides with a pane" any more: the ROOT is allocated before the
        // columns and now prefers the workspace's own id, so it is a second
        // thing this can collide with.
        `column id is already taken in this workspace; the split is "${allocated.id}"`,
      );
    }
    const split: SplitNode = {
      nodeType: 'split',
      id: allocated.id,
      parentId: rootId,
      position,
      axis: 'column',
      ...(share === null ? {} : { fraction: share }),
    };
    nodes.push(split);

    const columnShares = settleGroupShares(entry.panes.map((pane) => pane.heightFraction));
    if (sharesWereDiscarded(entry.panes.map((pane) => pane.heightFraction), columnShares)) {
      note('fractions_read_as_unsized', allocated.id, `the column's pane shares do not settle; read as unsized`);
    }
    entry.panes.forEach((pane, at) => {
      nodes.push(paneOf(pane, split.id, at, columnShares[at]));
    });
  });

  // The members with no pane row, seated after the columns — conversations
  // first, then shells, each oldest-first, so a re-run produces the same list.
  // Their `position` continues the root's own run, which is what makes it
  // contiguous with the columns rather than a second numbering beside them.
  seated.forEach((member, index) => {
    const position = populated.length + index;
    const share = rootShares[position];
    nodes.push({
      nodeType: 'pane',
      id: member.id,
      parentId: rootId,
      position,
      ...(share === null ? {} : { fraction: share }),
      target: member.target,
    });
  });

  // ---------------------------------------------------------------------
  // The gate. Nothing below this line repairs anything.
  // ---------------------------------------------------------------------
  const paneNodes = nodes.filter((node): node is PaneNode => node.nodeType === 'pane');
  const census: WorkspaceCensus = {
    workspaceId,
    columnsIn: source.columns.length,
    panesIn: source.panes.length,
    panesDroppedNotMember: droppedPanes.length,
    conversationsIn: source.conversations.length,
    shellsIn: source.shells.length,
    membersIn: livePanes.length + seated.length,
    nodesOut: nodes.length,
    paneNodesOut: paneNodes.length,
    splitNodesOut: nodes.filter((node) => node.nodeType === 'split').length,
    seatedOut: seated.length,
    boundChatNodesOut: paneNodes.filter((node) => node.target?.kind === 'chat').length,
    unboundPaneNodesOut: paneNodes.filter((node) => node.target === null).length,
    membershipDropped,
  };

  const empty: WorkspaceDerivation = { workspaceId, rows: [], census, notes, skipped: null };

  // The rehearsal's defect condition, enforced at derivation time rather than
  // only counted afterwards. Every member of the workspace becomes exactly one
  // pane node; if those two numbers differ, a member either lost its node or
  // grew a second one, and no report anybody reads later can undo an INSERT.
  if (census.membersIn !== census.paneNodesOut) {
    return {
      ...empty,
      skipped: {
        code: 'member_count_mismatch',
        detail: `${census.membersIn} members in, ${census.paneNodesOut} pane nodes out`,
      },
    };
  }

  const validation = validateTree(nodes);
  if (!validation.ok) {
    return { ...empty, skipped: { code: validation.code, detail: validation.detail } };
  }

  // Rule 1, asserted PER NODE rather than trusted from the loop that built
  // them. A node that carried another workspace's `rootId` would put real panes
  // in someone else's session — the failure this whole model exists to prevent,
  // and the migration is the one place it can still happen, because it is the
  // only code that holds more than one workspace's rows at a time.
  const rows: WorkspaceNodeRow[] = [];
  for (const node of nodes) {
    const row = rowFromNode(node, workspaceId);
    if (row.rootId !== workspaceId) {
      return {
        ...empty,
        skipped: {
          code: 'root_id_mismatch',
          detail: `node "${node.id}" was stamped with rootId "${row.rootId}", not "${workspaceId}"`,
        },
      };
    }
    rows.push(row);
  }

  // Read the rows back through the exact path production will use. It re-parses
  // every column against the discriminated union and refuses any row scoped to
  // another workspace, so a half-bound pane or a mis-stamped `rootId` fails
  // HERE, in a dry run, rather than at the INSERT that would have shipped it.
  try {
    nodesFromRows(rows, workspaceId);
  } catch (error) {
    return {
      ...empty,
      skipped: {
        code: 'row_round_trip',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return { workspaceId, rows, census, notes, skipped: null };
}
