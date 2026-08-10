/**
 * The node model's DB shell: THE read, THE write, and no decisions.
 *
 * Successor to the deleted `workspace-layout-store.ts`, and deliberately
 * smaller than it. That store had six methods; this has three, and the
 * difference is not tidiness:
 *
 *  * `getWorkspaceGrid` + `currentRev` are GONE, not renamed. They were two
 *    queries answering one question, and {@link readWorkspaceNodeSnapshots}
 *    answers it in one statement — see its doc for why that is a correctness
 *    property rather than a saved round trip.
 *  * `getWorkspaceGridsBulk` is gone too: the same statement serves one
 *    workspace and fifty, so the single case is the bulk case with a
 *    one-element list. There is no second reader to keep in step.
 *  * `findOp` / `recordOp` are gone with the table they read. The write
 *    primitive here is an UPSERT of a node set, so a retried POST re-applies to
 *    the same state and an idempotency memory has nothing left to remember.
 *
 * **The third method is not a second reader of a workspace.**
 * {@link readChatTargetHolders} asks the ONE question a workspace's own rows
 * cannot answer: `agent_workspace_nodes_chat_target_idx` is keyed on `targetId`
 * alone, with no `rootId` in it, so a conversation already bound in ANOTHER
 * workspace is invisible to every read above and to `validateTree` alike. It is
 * the runtime counterpart of the arbitration the backfill already performs
 * across the whole table (`resolveChatClaims`), and it lives here because this
 * module owns the node table. It still decides nothing — what the rows MEAN is
 * `../../agent-workspaces/workspace-node-chat-binding.ts`'s business.
 *
 * **The lock is re-exported, not re-cut.** {@link withWorkspaceLock} lives in
 * `./workspace-lock` because it is not this module's concern — it serializes
 * every writer of one workspace, whatever that writer writes — and callers reach
 * it from here so a node write imports its lock and its store from one place.
 * Two advisory locks keyed on the same workspace by two different hashes would
 * let two writers touch the same session at the same instant, so there is one.
 */

import { z } from 'zod';
import { and, eq, inArray, sql, type SQL } from '@pagespace/db/operators';
import { readFraction } from '../../agent-workspaces/workspace-fractions';
import type { ChatTargetHolder } from '../../agent-workspaces/workspace-node-chat-binding';
import type { WorkspaceNode } from '../../agent-workspaces/workspace-node';
import { nodesFromRows, rowFromNode, type WorkspaceNodeRow } from '../../agent-workspaces/workspace-node-rows';
import type { PersistedNodeWrite } from '../../agent-workspaces/workspace-node-write';
import type { DbExecutor } from './workspace-lock';

export { withWorkspaceLock } from './workspace-lock';
export type { DbExecutor } from './workspace-lock';

/**
 * One workspace's whole truth: a rev and the nodes that rev DESCRIBES.
 *
 * The pair is the unit precisely because it is the pair that goes wrong. A rev
 * newer than the nodes beside it is not "slightly ahead" — the client adopts it
 * as its base, and `applyRemoteUpdate`'s `payload.rev <= sync.rev` guard then
 * drops the next real broadcast on the floor, leaving the client wrong until the
 * next poll. That is why this type exists and why nothing hands out either half
 * on its own.
 */
export interface WorkspaceNodeSnapshot {
  /** 0 when no write has ever applied to this workspace. */
  rev: number;
  nodes: WorkspaceNode[];
}

/**
 * PARSE the joined read, one row at a time. Raw SQL means the column types are a
 * CLAIM about the database rather than something the type checker verified, and
 * a claim is worth exactly what checking it is worth — so this is where the
 * claim is checked, at the one place untyped storage becomes typed.
 */
const workspaceNodeJoinRowSchema = z.object({
  workspaceId: z.string().min(1),
  // Postgres `bigint` arrives as a STRING from node-postgres, which hands int8
  // back as text rather than risk a silent precision loss; the drizzle query
  // builder's `{mode: 'number'}` does that conversion, and raw SQL does not get
  // it for free. Coerced here, once, so nothing downstream has to remember.
  rev: z.union([z.number(), z.string()]).transform((value) => Number(value)),
  id: z.string().min(1).nullable(),
  parentId: z.string().min(1).nullable(),
  position: z.number().int().nullable(),
  // The domains are the table's own `..._node_type_chk` / `..._target_kind_chk`
  // CHECK constraints, restated at the one place untyped storage becomes typed.
  // A value outside them is a REJECTED read, never a node whose type is a lie.
  nodeType: z.enum(['root', 'split', 'pane']).nullable(),
  axis: z.enum(['row', 'column']).nullable(),
  fraction: z.number().nullable(),
  targetKind: z.enum(['chat', 'terminal', 'page']).nullable(),
  targetId: z.string().min(1).nullable(),
});

/**
 * One row of the joined read: the workspace's rev, plus one of its nodes — or
 * no node at all, when the workspace has a rev and an empty tree.
 */
export type WorkspaceNodeJoinRow = z.infer<typeof workspaceNodeJoinRowSchema>;

/**
 * The one capability the atomic read needs, named so a test can supply it
 * without a database — and, more to the point, so a test can COUNT it. The
 * atomicity this module claims is "one statement", and a claim about how many
 * statements a function issues is only checkable at a seam that sees them.
 *
 * `unknown[]`, not a generic: drizzle's own `execute` narrows its rows through
 * an `Assume<Row, QueryResultRow>` whose escape hatch is an `any`-indexed
 * signature, so a generic seam here could only match it by importing that `any`.
 * The rows are parsed anyway — this is a raw statement, so the column types are
 * a claim about the database rather than something the type checker verified —
 * and a parse that starts from `unknown` is the honest starting point for one.
 */
export interface NodeSnapshotExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/**
 * Rows → snapshots. Pure, and exported because it is where a workspace's rows
 * become its nodes: the grouping, the fraction funnel, and the scope check all
 * happen here rather than in the query.
 *
 * Every workspace ASKED FOR gets an entry, including one with no rev row and no
 * nodes. A missing entry would make "this workspace has never been written" and
 * "you did not ask about this workspace" the same answer, and the first of those
 * is a real state a caller has to render (an empty grid at rev 0), not an
 * absence.
 */
export function snapshotsFromJoinRows(
  rows: readonly WorkspaceNodeJoinRow[],
  workspaceIds: readonly string[],
): Map<string, WorkspaceNodeSnapshot> {
  const revs = new Map<string, number>();
  const rowsByWorkspace = new Map<string, WorkspaceNodeRow[]>();

  for (const row of rows) {
    revs.set(row.workspaceId, row.rev);
    if (row.id === null || row.nodeType === null || row.position === null) continue;
    const list = rowsByWorkspace.get(row.workspaceId) ?? [];
    list.push({
      id: row.id,
      rootId: row.workspaceId,
      parentId: row.parentId,
      position: row.position,
      nodeType: row.nodeType,
      axis: row.axis,
      // THE funnel, shared with the write's change detection. The column is a
      // Postgres `real`, so a double written out does not read back
      // bit-identical — and without one shared quantization every re-send of a
      // sized tree would look like a change, bump a rev and broadcast. It also
      // turns the two float4 values that are not shares of anything (a
      // non-positive one, an infinity) into the honest "unsized" rather than
      // into a node `validateTree` has to reject.
      fraction: readFraction(row.fraction),
      targetKind: row.targetKind,
      targetId: row.targetId,
    });
    rowsByWorkspace.set(row.workspaceId, list);
  }

  const snapshots = new Map<string, WorkspaceNodeSnapshot>();
  for (const workspaceId of workspaceIds) {
    snapshots.set(workspaceId, {
      rev: revs.get(workspaceId) ?? 0,
      // Through `nodesFromRows`, not `nodeFromRow` in a loop: it is told which
      // workspace it read and rejects any row that disagrees, which is one of
      // only two places a node's workspace can change. The grouping above makes
      // a disagreement impossible, and the check stays because "impossible by
      // construction" is what every drift in this epic was before it happened.
      nodes: nodesFromRows(rowsByWorkspace.get(workspaceId) ?? [], workspaceId),
    });
  }
  return snapshots;
}

/**
 * THE ATOMIC READ — `{rev, nodes}` for any number of workspaces, in ONE
 * statement.
 *
 * **Why one statement and not two careful ones.** Reading the rev and the nodes
 * separately gives a pair that describes no state the workspace was ever in.
 * When it OVER-claims — a rev newer than the rows beside it — the client adopts
 * that rev as its base, and the next broadcast, which carries exactly that rev,
 * is discarded by `applyRemoteUpdate`'s `payload.rev <= sync.rev` guard. The
 * client then renders a tree the server no longer holds until something else
 * happens to make it poll. A read ordering that under-claims safely would close
 * the same hole, and it would close it by convention: a rule living nowhere but
 * in the order of two lines, which the next person to touch this file has no way
 * to see. In one statement Postgres takes one snapshot by definition, and the
 * property is a fact about the database rather than a fact about the author.
 *
 * **Why FULL OUTER and not LEFT.** Driving from the revs table alone makes a
 * workspace with node rows and no rev row read as EMPTY — the very "a workspace
 * exists holding nothing" symptom this epic is here to delete, arriving from the
 * other side. Nothing in the write path can produce that state (the rev is
 * minted in the transaction that writes the rows), but a backfill can, and
 * answering "there is nothing here" about a workspace full of panes is the worst
 * available failure. The two filtered subqueries keep it to two index scans
 * rather than a join across every workspace in the table.
 */
export async function readWorkspaceNodeSnapshots(
  executor: NodeSnapshotExecutor,
  workspaceIds: readonly string[],
): Promise<Map<string, WorkspaceNodeSnapshot>> {
  if (workspaceIds.length === 0) return new Map();
  const { agentWorkspaceNodes, agentWorkspaceNodeRevs } = await import('@pagespace/db/schema/agent-workspace-nodes');
  const ids = [...workspaceIds];

  const result = await executor.execute(sql`
    SELECT
      COALESCE(r."rootId", n."rootId") AS "workspaceId",
      COALESCE(r."rev", 0)             AS "rev",
      n."id"          AS "id",
      n."parentId"    AS "parentId",
      n."position"    AS "position",
      n."nodeType"    AS "nodeType",
      n."axis"        AS "axis",
      n."fraction"    AS "fraction",
      n."targetKind"  AS "targetKind",
      n."targetId"    AS "targetId"
    FROM (
      SELECT * FROM ${agentWorkspaceNodeRevs} WHERE ${inArray(agentWorkspaceNodeRevs.rootId, ids)}
    ) r
    FULL OUTER JOIN (
      SELECT * FROM ${agentWorkspaceNodes} WHERE ${inArray(agentWorkspaceNodes.rootId, ids)}
    ) n ON n."rootId" = r."rootId"
  `);

  return snapshotsFromJoinRows(result.rows.map((row) => workspaceNodeJoinRowSchema.parse(row)), ids);
}

/** One workspace's snapshot. The bulk read with a one-element list — there is no second reader. */
export async function readWorkspaceNodeSnapshot(
  executor: NodeSnapshotExecutor,
  workspaceId: string,
): Promise<WorkspaceNodeSnapshot> {
  const snapshots = await readWorkspaceNodeSnapshots(executor, [workspaceId]);
  return snapshots.get(workspaceId) ?? { rev: 0, nodes: [] };
}

/**
 * WHO ELSE HOLDS THESE CONVERSATIONS — across the WHOLE table, not one
 * workspace.
 *
 * The one query in this module that is deliberately unscoped by `rootId`,
 * because the constraint it stands in front of is:
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` has no `rootId` in its key, so
 * "is this conversation free to bind" is not a question a workspace's own rows
 * can be asked. Mirrors `loadClaimedChatTargets` in
 * `scripts/backfill-agent-workspace-nodes.ts`, which asks the identical
 * question of the identical index for historical rows — one shape, two
 * callers, rather than a second way of asking.
 *
 * It returns the HOLDER, not a boolean: the caller has to tell "held here" from
 * "held elsewhere", and that discrimination belongs in
 * {@link conflictingChatTargets} where it can be read, not in a `where` clause
 * where it cannot.
 *
 * Unchunked, unlike the backfill's version, and the difference is a real bound
 * rather than an oversight: a write payload is capped at `MAX_NODES` (2048) by
 * the wire schema, so the `IN` list has a ceiling the migration's full-table
 * sweep does not have.
 *
 * Takes the caller's executor so the lookup runs on the transaction that will
 * do the write, rather than reaching past it for a second pooled connection
 * while that transaction holds the workspace's advisory lock.
 */
export async function readChatTargetHolders(
  executor: DbExecutor,
  targetIds: readonly string[],
): Promise<ChatTargetHolder[]> {
  if (targetIds.length === 0) return [];
  const { agentWorkspaceNodes } = await import('@pagespace/db/schema/agent-workspace-nodes');

  const rows = await executor
    .select({
      rootId: agentWorkspaceNodes.rootId,
      nodeId: agentWorkspaceNodes.id,
      targetId: agentWorkspaceNodes.targetId,
    })
    .from(agentWorkspaceNodes)
    .where(
      and(
        eq(agentWorkspaceNodes.targetKind, 'chat'),
        inArray(agentWorkspaceNodes.targetId, [...targetIds]),
      ),
    );

  // `targetId` is a nullable column, so the row type is nullable however
  // impossible the predicate makes it. Narrowed by filtering rather than by a
  // cast, for the reason this whole model states everywhere else: a cast is a
  // lie the type checker vouches for.
  return rows.flatMap((row) =>
    row.targetId === null ? [] : [{ rootId: row.rootId, nodeId: row.nodeId, targetId: row.targetId }],
  );
}

/**
 * Which of these chat targets no longer have a thread behind them.
 *
 * The third global question about a chat target, beside "may this caller show
 * it" (the ACL gate) and "will the table let anyone" ({@link
 * readChatTargetHolders}): is there still a conversation here at all. Like
 * those, it is unscoped by `rootId` — liveness is a property of the thread, not
 * of the grid asking about it — and like `readChatTargetHolders` it takes the
 * caller's executor so it runs on the transaction that is about to write,
 * rather than on a pooled connection whose answer can go stale before the
 * insert lands. That is the entire point of it: every admission path already
 * asks this question BEFORE taking the lock, and a history-delete fits in the
 * gap.
 *
 * A target with NO conversation row is reported here too, though nothing can
 * reach this with one: `authorizePaneScope` refuses an unknown conversation as
 * `forbidden_target` first, and that 403 has to win so a caller cannot use this
 * answer as an existence oracle.
 *
 * **`FOR SHARE`, and it is the whole difference between narrowing this race and
 * closing it.** A plain `SELECT` takes no lock, so a history-delete's `UPDATE
 * … SET "isActive" = false` could still commit between this read and this
 * transaction's own commit, leaving a node bound to a thread that had just
 * died. `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` a plain `UPDATE`
 * acquires, so the two serialize on the CONVERSATION ROW — the one thing both
 * sides touch, and the reason no arrangement of workspace locks could ever have
 * settled it (a claim may land in a workspace the delete has never heard of).
 *
 * Whichever gets the row first, the outcome is a state someone asked for: the
 * claim first, and the delete waits, so the node exists and is visible to the
 * post-delete sweep that removes it; the delete first, and the claim's read
 * blocks, then sees `isActive = false` and refuses. Verified against this
 * repo's Postgres rather than taken from the lock-conflict table: holding
 * `FOR SHARE` open makes the soft-delete's `UPDATE` sit until `lock_timeout`.
 *
 * SHARE and not UPDATE, because concurrent claims of ONE conversation must
 * still both be allowed to read it — the single-node rule is the unique index's
 * to enforce, not this lock's — and because a shared lock is what makes this
 * cost nothing on the ordinary path, where no delete is racing anybody.
 */
export async function readDeletedChatTargets(
  executor: DbExecutor,
  targetIds: readonly string[],
): Promise<string[]> {
  if (targetIds.length === 0) return [];
  const { conversations } = await import('@pagespace/db/schema/conversations');

  const live = await executor
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(inArray(conversations.id, [...targetIds]), eq(conversations.isActive, true)))
    .for('share');

  const alive = new Set(live.map((row) => row.id));
  return targetIds.filter((id) => !alive.has(id));
}

/**
 * Persist a decided write and mint the workspace's next rev.
 *
 * Takes {@link PersistedNodeWrite} — the storage instruction `decideNodeWrite`
 * derived — never the caller's payload. This function decides nothing: it does
 * not validate, does not compare, and does not know what a tree is.
 *
 * **RELEASE first, then ONE upsert.** The order is what keeps the table's global
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` satisfiable when a write moves a
 * conversation from one node to another: upserting first would make two rows
 * hold it for the length of the transaction. Releasing has two halves, because
 * a conversation can leave a node in two different ways:
 *
 *  - **The node goes.** `write.drop` is deleted first, which frees whatever it
 *    held.
 *  - **The node stays and stops holding it.** This one is not covered by the
 *    delete, and it is the case a partial unique index punishes hardest. A
 *    write that hands chat C from `n1` to `n2` while KEEPING both nodes has an
 *    empty `drop`, so the upsert is the only statement — and a unique index is
 *    checked as each row is written, not at end of statement. If `n2` is
 *    written before `n1`, two live rows hold C for an instant and the write is
 *    rejected even though the tree it asks for is perfectly valid. A SWAP
 *    (`n1: C→D`, `n2: D→C`) has no row order that avoids it at all.
 *
 * So every node named in `put` has its chat binding cleared before the upsert
 * restates it. Any row still holding one of those conversations afterwards is a
 * node the write did not mention, which is a genuine duplicate in the final
 * tree — and `validateTree` has already refused it upstream.
 *
 * The upsert itself is a SINGLE multi-row statement on purpose — Postgres checks
 * foreign keys at end of statement, so a child and the parent it arrives under
 * may appear in any order within it, and no caller has to topologically sort a
 * tree it already validated. Only the unique index needs the help.
 *
 * The rev mint doubles as the serializing row lock, exactly as
 * `agent_workspace_layout_revs`' did — and lives in its own table so that lock
 * never lands on the `agent_workspaces` row sandbox provisioning contends on.
 *
 * Must run inside `withWorkspaceLock`: the read that decided this write has
 * to be in the same lock scope, or two callers compute from one base and the
 * later commit silently drops the earlier one's change.
 */
/**
 * Is this workspace still WAITING FOR THE BACKFILL — does it hold membership
 * the old model records and the node model has never been given?
 *
 * Two conditions, and the shape of them is the third attempt. The refusal this
 * feeds is unrecoverable by design, so the predicate has to be true for every
 * workspace the backfill still owes a node to, and false the moment it has paid.
 *
 *  1. **No `agent_workspace_node_revs` row.** THE MIGRATION MARKER, and the
 *     reason this is not simply "are there nodes?". The backfill writes
 *     `rev = 0` in the same transaction as the nodes, `writeWorkspaceNodes` only
 *     ever increments it, and nothing deletes it — `destroy` removes nodes and
 *     leaves the rev standing. So it answers "has this workspace ever been
 *     through the node model" monotonically and cannot un-answer itself.
 *
 *     An earlier cut asked "is there a legacy row with no node", which is a
 *     different question that coincides during the migration window and diverges
 *     the moment a tree is legitimately emptied: `endSession` destroys the whole
 *     tree, so ending a session and reusing it made a correctly-backfilled
 *     workspace look un-backfilled and refused every write after that.
 *
 *  2. **Some legacy source row exists.** This is what separates "never
 *     backfilled" from "brand new". Given (1), any such row is one the backfill
 *     has not processed, so the three sources it derives from are checked the
 *     way it derives them — panes, conversations, AND shells. An earlier cut
 *     looked only at `conversations.workspaceId` while claiming to cover the
 *     backfill's sources, so a workspace whose legacy membership was a pane row
 *     or a shell passed the guard, got seeded, and was then reported
 *     `alreadyMigrated` by the very run that should have saved it.
 *
 *     A brand-new workspace matches none of them: the pane tables are dead,
 *     nothing writes `conversations.workspaceId`, and a shell created after the
 *     cutover goes through the node write path and therefore already has (1).
 *
 * **There is deliberately no `endedAt` clause.** One used to be here, exempting
 * ended workspaces because the backfill skipped them. That exemption permitted
 * exactly the write that makes the exemption false: claiming a thread into an
 * ended workspace UN-ENDS it (`planSessionReopen` clears `endedAt`), which mints
 * a rev row and disarms this guard for good, after which the backfill reports
 * the workspace `alreadyMigrated` and its real membership is stranded forever.
 * The backfill now covers every workspace instead, so the guard needs no
 * exemption and its scope is the drop's scope.
 *
 * Costs two indexed lookups, and only on the seed path — a workspace's first
 * write while it has no tree. After the follow-up migration drops the old
 * columns and tables, this function and its call site go with them.
 */
export async function awaitsBackfill(
  executor: DbExecutor,
  workspaceId: string,
): Promise<boolean> {
  const { agentWorkspaceNodeRevs } = await import('@pagespace/db/schema/agent-workspace-nodes');

  const [migrated] = await executor
    .select({ rootId: agentWorkspaceNodeRevs.rootId })
    .from(agentWorkspaceNodeRevs)
    .where(eq(agentWorkspaceNodeRevs.rootId, workspaceId))
    .limit(1);

  if (migrated !== undefined) return false;

  // The backfill's own three sources, asked as one question. `sql` rather than
  // the query builder because this is a pure existence test across three
  // unrelated tables and a UNION of `SELECT 1`s says that plainly.
  const result = await executor.execute(sql`
    SELECT 1 AS present WHERE EXISTS (
      SELECT 1 FROM "agent_workspace_panes" p WHERE p."workspaceId" = ${workspaceId}
      UNION ALL
      SELECT 1 FROM "agent_workspace_shells" s WHERE s."workspaceId" = ${workspaceId}
      UNION ALL
      SELECT 1 FROM "conversations" c
       WHERE c."workspaceId" = ${workspaceId}
         AND c."isActive" = true
         AND c."closedInWorkspaceAt" IS NULL
    )
  `);

  // node-postgres hands back a `QueryResult`; a driver that returns the rows
  // directly is handled too, because this module is also run against a
  // transaction executor and the two differ on exactly this.
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}

export async function writeWorkspaceNodes(
  executor: DbExecutor,
  input: { workspaceId: string; write: PersistedNodeWrite },
): Promise<number> {
  const { workspaceId, write } = input;
  const { agentWorkspaceNodes, agentWorkspaceNodeRevs } = await import(
    '@pagespace/db/schema/agent-workspace-nodes'
  );

  if (write.drop.length > 0) {
    // Scoped by `rootId` as well as by id, and not because ids collide by
    // accident: they are CLIENT-MINTED, so two workspaces holding the same id is
    // legitimate, and the compound primary key is the only thing that makes
    // "this id" mean one row. A bare `id IN (...)` would delete someone else's.
    await executor
      .delete(agentWorkspaceNodes)
      .where(and(eq(agentWorkspaceNodes.rootId, workspaceId), inArray(agentWorkspaceNodes.id, write.drop)));
  }

  if (write.put.length > 0) {
    // The second half of the release — see the docblock. Scoped three ways, and
    // each one is load-bearing:
    //
    //  * to writes that TAKE a chat target at all. A resize drag or a move puts
    //    nodes without binding anything, and nothing can collide on an index
    //    over a value no row is acquiring — so the commonest write on the
    //    system skips this statement entirely rather than paying for a case it
    //    cannot be in.
    //  * to `chat`, the only kind the partial index covers.
    //  * to the ids this write is about to restate, so it can never disturb a
    //    node the write did not name — which is also what keeps a genuine
    //    duplicate refused instead of quietly released.
    const takesChatTarget = write.put.some(
      (node) => node.nodeType === 'pane' && node.target?.kind === 'chat',
    );
    if (takesChatTarget) {
      await executor
        .update(agentWorkspaceNodes)
        .set({ targetKind: null, targetId: null })
        .where(
          and(
            eq(agentWorkspaceNodes.rootId, workspaceId),
            inArray(agentWorkspaceNodes.id, write.put.map((node) => node.id)),
            eq(agentWorkspaceNodes.targetKind, 'chat'),
          ),
        );
    }

    const now = new Date();
    await executor
      .insert(agentWorkspaceNodes)
      .values(write.put.map((node) => ({ ...rowFromNode(node, workspaceId), createdAt: now, updatedAt: now })))
      .onConflictDoUpdate({
        target: [agentWorkspaceNodes.rootId, agentWorkspaceNodes.id],
        set: {
          parentId: sql`excluded."parentId"`,
          position: sql`excluded."position"`,
          nodeType: sql`excluded."nodeType"`,
          axis: sql`excluded."axis"`,
          fraction: sql`excluded."fraction"`,
          targetKind: sql`excluded."targetKind"`,
          targetId: sql`excluded."targetId"`,
          updatedAt: now,
        },
      });
  }

  const [{ rev }] = await executor
    .insert(agentWorkspaceNodeRevs)
    .values({ rootId: workspaceId, rev: 1 })
    .onConflictDoUpdate({
      target: agentWorkspaceNodeRevs.rootId,
      set: { rev: sql`${agentWorkspaceNodeRevs.rev} + 1` },
    })
    .returning({ rev: agentWorkspaceNodeRevs.rev });
  return rev;
}
