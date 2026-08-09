/**
 * The node model's DB shell: ONE read, ONE write, and no decisions.
 *
 * Successor to `workspace-layout-store.ts`, and deliberately smaller than it.
 * That store had six methods; this has two, and the difference is not tidiness:
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
 * **The lock is deliberately the OLD one.** `withWorkspaceLayoutLock` is
 * imported rather than re-cut, so a node write and a legacy verb write for the
 * same workspace serialize against EACH OTHER for the whole of the migration
 * window. Two advisory locks keyed on the same workspace by two different hashes
 * would let the two models write the same session at the same instant, which is
 * the one thing a cutover cannot survive.
 */

import { z } from 'zod';
import { and, eq, inArray, sql, type SQL } from '@pagespace/db/operators';
import { readFraction } from '../../agent-workspaces/workspace-layout-verbs';
import type { WorkspaceNode } from '../../agent-workspaces/workspace-node';
import { nodesFromRows, rowFromNode, type WorkspaceNodeRow } from '../../agent-workspaces/workspace-node-rows';
import type { PersistedNodeWrite } from '../../agent-workspaces/workspace-node-write';
import type { DbExecutor } from './workspace-layout-store';

export { withWorkspaceLayoutLock } from './workspace-layout-store';
export type { DbExecutor } from './workspace-layout-store';

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
 * Persist a decided write and mint the workspace's next rev.
 *
 * Takes {@link PersistedNodeWrite} — the storage instruction `decideNodeWrite`
 * derived — never the caller's payload. This function decides nothing: it does
 * not validate, does not compare, and does not know what a tree is.
 *
 * **DELETE first, then ONE upsert.** The order is what keeps the table's global
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` satisfiable when a write moves a
 * conversation from one node to another: upserting first would make two rows
 * hold it for the length of the transaction. The upsert is a SINGLE multi-row
 * statement on purpose — Postgres checks foreign keys at end of statement, so a
 * child and the parent it arrives under may appear in any order within it, and
 * no caller has to topologically sort a tree it already validated.
 *
 * The rev mint doubles as the serializing row lock, exactly as
 * `agent_workspace_layout_revs`' did — and lives in its own table so that lock
 * never lands on the `agent_workspaces` row sandbox provisioning contends on.
 *
 * Must run inside `withWorkspaceLayoutLock`: the read that decided this write has
 * to be in the same lock scope, or two callers compute from one base and the
 * later commit silently drops the earlier one's change.
 */
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
