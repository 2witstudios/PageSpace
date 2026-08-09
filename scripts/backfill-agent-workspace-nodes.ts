#!/usr/bin/env bun
/**
 * Backfill Script: every live workspace's pane grid and membership → the flat
 * node model (`agent_workspace_nodes`, migration `0255_boring_leo.sql`).
 *
 * This is the thin I/O shell. Every decision the migration makes lives in
 * `@pagespace/lib/agent-workspaces/workspace-node-backfill` — a pure function
 * over rows, tested without a database — because this runs ONCE over every real
 * workspace that exists, with no gradual rollout and no second chance. Code
 * that is hard to test is a design failure at this blast radius, not an
 * inconvenience, so what is left here is: read rows, hand them over, write what
 * comes back, count everything.
 *
 * **ADDITIVE ONLY.** The only statements this issues against user data are
 * INSERTs into `agent_workspace_nodes` and `agent_workspace_node_revs`. It does
 * not delete, update or touch `agent_workspace_pane_columns`,
 * `agent_workspace_panes` or `conversations` — those stay live as a read-only
 * shadow, which is what makes rollback a redeploy rather than a restore.
 *
 * **Idempotent and resumable.** A workspace that already holds any node row is
 * skipped whole, so a second run writes nothing and a run resumed after a
 * partial failure continues from where it stopped rather than restarting or
 * skipping ahead. Chat targets an earlier run already bound are read back and
 * withheld from this one, so a resume cannot fight the unique index it
 * half-filled.
 *
 * **Dry-run by default.** `--apply` is the only thing that writes. The dry run
 * is the rehearsal: it produces the same per-workspace census a live run does,
 * having derived and validated every workspace, without an INSERT anywhere.
 *
 * Usage:
 *   bun scripts/backfill-agent-workspace-nodes.ts                 # dry run (default)
 *   bun scripts/backfill-agent-workspace-nodes.ts --workspace ID  # one workspace
 *   bun scripts/backfill-agent-workspace-nodes.ts --limit 100     # first N live workspaces
 *   bun scripts/backfill-agent-workspace-nodes.ts --quiet         # totals only
 *   bun scripts/backfill-agent-workspace-nodes.ts --apply         # live write
 *
 * ─── Production procedure ──────────────────────────────────────────────────
 * 1. Deploy migration 0255 (the node tables — additive and inert on arrival).
 * 2. Run this DRY and read the census. Any workspace reported as SKIPPED is one
 *    a human looks at before cutover; it stays on the old tables until then.
 * 3. Run with `--apply` as a one-off machine on the migrate image.
 * 4. Only then deploy the app image that reads nodes. DO NOT run this against
 *    production yourself — document only.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { getMigrationDb } from '@pagespace/db/db';
import { agentWorkspaces, agentWorkspaceShells } from '@pagespace/db/schema/agent-workspaces';
import {
  agentWorkspacePaneColumns,
  agentWorkspacePanes,
} from '@pagespace/db/schema/agent-workspace-layout';
import { agentWorkspaceNodes, agentWorkspaceNodeRevs } from '@pagespace/db/schema';
import { conversations } from '@pagespace/db/schema/conversations';
import { and, asc, eq, gt, inArray, isNotNull, isNull } from '@pagespace/db/operators';
import {
  deriveWorkspaceNodes,
  resolveChatClaims,
  type ChatPaneReference,
  type WorkspaceBackfillSource,
  type WorkspaceDerivation,
  type WorkspaceCensus,
} from '@pagespace/lib/agent-workspaces/workspace-node-backfill';

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db), so a
// full scan of the workspace tables can't be aborted by the app pool's
// statement_timeout.
const db = getMigrationDb();

type Db = typeof db;

/** Workspaces read per round trip. Small: each one drags four child queries behind it. */
const BATCH_SIZE = 50;

/** Ids per `IN (...)`. Postgres copes with far more; this keeps plans stable. */
const CHUNK_SIZE = 500;

/**
 * Pause between workspace writes.
 *
 * This touches EVERY workspace, and a tight insert loop against the primary is
 * a production incident dressed as a migration — it is the same pool the app's
 * own writes come from. 25ms is ~40 workspaces/second, which finishes any real
 * corpus in minutes while leaving the connection idle most of the time.
 * Overridable for a rehearsal against a restored snapshot, where nothing is
 * competing for the pool.
 */
const SLEEP_MS = Number(process.env.WORKSPACE_NODE_BACKFILL_SLEEP_MS ?? 25);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// The claim pre-pass
// ---------------------------------------------------------------------------

/**
 * Decide globally, before any workspace is derived, which workspace may bind
 * each conversation a pane row names.
 *
 * It has to be global and it has to be first. `UNIQUE (targetId) WHERE
 * targetKind = 'chat'` spans the whole table, and a pane naming a conversation
 * in another session is reachable today, so a workspace processed in batch 1
 * could otherwise take a thread whose owner is not read until batch 9 — and
 * that thread would then be invisible in the session it actually belongs to.
 * Deciding up front is what makes the answer independent of batch order.
 *
 * The query is small and bounded by the number of pane rows, not by the number
 * of conversations: contention is only possible between PANE references, since
 * membership follows `conversations.workspaceId`, which is single-valued and
 * therefore cannot contend with itself.
 */
async function loadChatClaims(dbInstance: Db): Promise<Map<string, string>> {
  const paneRows = await dbInstance
    .select({
      workspaceId: agentWorkspacePanes.workspaceId,
      conversationId: agentWorkspacePanes.targetId,
    })
    .from(agentWorkspacePanes)
    .innerJoin(agentWorkspaces, eq(agentWorkspaces.id, agentWorkspacePanes.workspaceId))
    .where(
      and(
        isNull(agentWorkspaces.endedAt),
        eq(agentWorkspacePanes.kind, 'chat'),
        isNotNull(agentWorkspacePanes.targetId),
      ),
    );

  const references: ChatPaneReference[] = paneRows
    .filter((row): row is { workspaceId: string; conversationId: string } => row.conversationId !== null)
    .map((row) => ({ workspaceId: row.workspaceId, conversationId: row.conversationId }));

  const targetIds = [...new Set(references.map((reference) => reference.conversationId))];

  // Who has an UNCONDITIONAL claim: a conversation that a live workspace will
  // emit a membership node for. "Open" is `countOpenConversations`' predicate,
  // spelled the same way here on purpose — bound, `isActive`, and not closed
  // out of the session's listing.
  const membershipOwner = new Map<string, string>();
  for (const chunk of chunked(targetIds, CHUNK_SIZE)) {
    const owners = await dbInstance
      .select({ conversationId: conversations.id, workspaceId: conversations.workspaceId })
      .from(conversations)
      .innerJoin(agentWorkspaces, eq(agentWorkspaces.id, conversations.workspaceId))
      .where(
        and(
          inArray(conversations.id, chunk),
          eq(conversations.isActive, true),
          isNull(conversations.closedInWorkspaceAt),
          isNull(agentWorkspaces.endedAt),
        ),
      );
    for (const owner of owners) {
      if (owner.workspaceId !== null) membershipOwner.set(owner.conversationId, owner.workspaceId);
    }
  }

  const claimed = await loadClaimedChatTargets(dbInstance, targetIds);
  return resolveChatClaims({ references, membershipOwner, claimed });
}

/** Chat targets an earlier run already bound. Nothing in this run may claim one. */
async function loadClaimedChatTargets(
  dbInstance: Db,
  targetIds: readonly string[],
): Promise<Set<string>> {
  const claimed = new Set<string>();
  for (const chunk of chunked(targetIds, CHUNK_SIZE)) {
    const rows = await dbInstance
      .select({ targetId: agentWorkspaceNodes.targetId })
      .from(agentWorkspaceNodes)
      .where(and(eq(agentWorkspaceNodes.targetKind, 'chat'), inArray(agentWorkspaceNodes.targetId, chunk)));
    for (const row of rows) {
      if (row.targetId !== null) claimed.add(row.targetId);
    }
  }
  return claimed;
}

// ---------------------------------------------------------------------------
// Reading a batch
// ---------------------------------------------------------------------------

/** Group rows by their workspace, so each derivation sees only its own. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row)) ?? [];
    bucket.push(row);
    grouped.set(key(row), bucket);
  }
  return grouped;
}

async function loadSources(dbInstance: Db, workspaceIds: string[]): Promise<WorkspaceBackfillSource[]> {
  const [columnRows, paneRows, conversationRows, shellRows] = await Promise.all([
    dbInstance
      .select({
        workspaceId: agentWorkspacePaneColumns.workspaceId,
        id: agentWorkspacePaneColumns.id,
        orderIndex: agentWorkspacePaneColumns.orderIndex,
        widthFraction: agentWorkspacePaneColumns.widthFraction,
      })
      .from(agentWorkspacePaneColumns)
      .where(inArray(agentWorkspacePaneColumns.workspaceId, workspaceIds)),
    dbInstance
      .select({
        workspaceId: agentWorkspacePanes.workspaceId,
        id: agentWorkspacePanes.id,
        columnId: agentWorkspacePanes.columnId,
        orderIndex: agentWorkspacePanes.orderIndex,
        kind: agentWorkspacePanes.kind,
        targetId: agentWorkspacePanes.targetId,
        heightFraction: agentWorkspacePanes.heightFraction,
      })
      .from(agentWorkspacePanes)
      .where(inArray(agentWorkspacePanes.workspaceId, workspaceIds)),
    // The membership predicate, identical to `countOpenConversations`': bound,
    // history-alive, and not closed out of the session's listing. A thread the
    // user dismissed is deliberately NOT a member — materialising it as a
    // detached node would reopen every thread everyone ever closed.
    dbInstance
      .select({
        workspaceId: conversations.workspaceId,
        id: conversations.id,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(
        and(
          inArray(conversations.workspaceId, workspaceIds),
          eq(conversations.isActive, true),
          isNull(conversations.closedInWorkspaceAt),
        ),
      ),
    dbInstance
      .select({
        workspaceId: agentWorkspaceShells.workspaceId,
        id: agentWorkspaceShells.id,
        createdAt: agentWorkspaceShells.createdAt,
      })
      .from(agentWorkspaceShells)
      .where(inArray(agentWorkspaceShells.workspaceId, workspaceIds)),
  ]);

  const columns = groupBy(columnRows, (row) => row.workspaceId);
  const panes = groupBy(paneRows, (row) => row.workspaceId);
  const threads = groupBy(
    conversationRows.filter((row): row is typeof row & { workspaceId: string } => row.workspaceId !== null),
    (row) => row.workspaceId,
  );
  const shells = groupBy(shellRows, (row) => row.workspaceId);

  return workspaceIds.map((workspaceId) => ({
    workspaceId,
    columns: columns.get(workspaceId) ?? [],
    panes: panes.get(workspaceId) ?? [],
    conversations: threads.get(workspaceId) ?? [],
    shells: shells.get(workspaceId) ?? [],
  }));
}

/** Workspaces that already hold nodes — a previous run got to them. */
async function loadAlreadyMigrated(dbInstance: Db, workspaceIds: string[]): Promise<Set<string>> {
  const rows = await dbInstance
    .selectDistinct({ rootId: agentWorkspaceNodes.rootId })
    .from(agentWorkspaceNodes)
    .where(inArray(agentWorkspaceNodes.rootId, workspaceIds));
  return new Set(rows.map((row) => row.rootId));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write one workspace's nodes, all of them or none.
 *
 * The rev row is seeded alongside so the workspace arrives complete rather than
 * materialising on its first edit; `onConflictDoNothing` because a resumed run
 * may find it already there and a rev is a counter, never something to reset.
 */
async function writeWorkspace(dbInstance: Db, derived: WorkspaceDerivation): Promise<void> {
  const now = new Date();
  await dbInstance.transaction(async (tx) => {
    await tx.insert(agentWorkspaceNodes).values(
      derived.rows.map((row) => ({ ...row, createdAt: now, updatedAt: now })),
    );
    await tx
      .insert(agentWorkspaceNodeRevs)
      .values({ rootId: derived.workspaceId, rev: 0 })
      .onConflictDoNothing();
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  dryRun: boolean;
  /** Stop after this many live workspaces. Omitted means all of them. */
  limit?: number;
  /** Derive exactly one workspace, by id — the shape a post-mortem needs. */
  only?: string;
  /** Suppress the per-workspace lines and print only the totals. */
  quiet?: boolean;
}

export type BackfillTotals = {
  workspacesScanned: number;
  alreadyMigrated: number;
  written: number;
  skipped: number;
  failed: number;
  /**
   * DERIVED from `WorkspaceCensus`, not restated. These counters were declared
   * here by hand, and when the lib renamed `detachedOut` to `seatedOut` this
   * file kept the old name: `census.detachedOut` read `undefined`, every total
   * became `NaN`, and the operator's per-workspace readout — the one thing
   * standing between a bad derivation and an irreversible one-shot migration —
   * printed `panes 2→NaN`. Nothing caught it, because `scripts/` is in no
   * tsconfig. Deriving the shape is what makes the next rename a compile error
   * rather than a silent `NaN`.
   */
} & Pick<
  WorkspaceCensus,
  'panesIn' | 'conversationsIn' | 'shellsIn' | 'membersIn' | 'nodesOut' | 'paneNodesOut' | 'seatedOut' | 'membershipDropped'
> & {
  notes: Record<string, number>;
  skips: Record<string, number>;
}

function emptyTotals(): BackfillTotals {
  return {
    workspacesScanned: 0,
    alreadyMigrated: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    panesIn: 0,
    conversationsIn: 0,
    shellsIn: 0,
    membersIn: 0,
    nodesOut: 0,
    paneNodesOut: 0,
    seatedOut: 0,
    membershipDropped: 0,
    notes: {},
    skips: {},
  };
}

export async function backfill(
  options: BackfillOptions,
  dbInstance: Db = db,
): Promise<BackfillTotals> {
  const { dryRun, limit, only, quiet } = options;
  const totals = emptyTotals();

  console.log(
    `🌳 agent workspace node backfill — ${dryRun ? 'DRY RUN (nothing is written)' : 'APPLYING'}` +
      `${only ? `, workspace ${only}` : ''}${limit ? `, limit ${limit}` : ''}`,
  );

  const chatClaims = await loadChatClaims(dbInstance);
  console.log(`   ${chatClaims.size} conversation(s) with a resolved chat claim`);

  // Keyset pagination by id — the same order the claim pre-pass tie-breaks on,
  // so a re-run walks the corpus identically even as rows are added underneath.
  let cursor: string | null = null;
  for (;;) {
    const conditions = [isNull(agentWorkspaces.endedAt)];
    if (only !== undefined) conditions.push(eq(agentWorkspaces.id, only));
    if (cursor !== null) conditions.push(gt(agentWorkspaces.id, cursor));

    const remaining = limit === undefined ? BATCH_SIZE : Math.min(BATCH_SIZE, limit - totals.workspacesScanned);
    if (remaining <= 0) break;

    const batch = await dbInstance
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(and(...conditions))
      .orderBy(asc(agentWorkspaces.id))
      .limit(remaining);
    if (batch.length === 0) break;

    const workspaceIds = batch.map((row) => row.id);
    totals.workspacesScanned += workspaceIds.length;
    cursor = workspaceIds[workspaceIds.length - 1];

    const alreadyMigrated = await loadAlreadyMigrated(dbInstance, workspaceIds);
    const pending = workspaceIds.filter((id) => !alreadyMigrated.has(id));
    totals.alreadyMigrated += workspaceIds.length - pending.length;

    if (pending.length > 0) {
      const sources = await loadSources(dbInstance, pending);

      // Everything the derivation needs to know about rows OUTSIDE the batch:
      // which conversations exist at all (reported, never acted on — the
      // binding has no FK by design) and which are already bound elsewhere.
      const batchChatTargets = [
        ...new Set([
          ...sources.flatMap((entry) =>
            entry.panes
              .filter((pane) => pane.kind === 'chat' && pane.targetId !== null)
              .map((pane) => pane.targetId as string),
          ),
          ...sources.flatMap((entry) => entry.conversations.map((thread) => thread.id)),
        ]),
      ];
      const [knownConversationIds, claimedChatTargets] = await Promise.all([
        loadKnownConversationIds(dbInstance, batchChatTargets),
        loadClaimedChatTargets(dbInstance, batchChatTargets),
      ]);

      for (const entry of sources) {
        const derived = deriveWorkspaceNodes(entry, {
          chatClaims,
          claimedChatTargets,
          knownConversationIds,
        });
        recordCensus(totals, derived);

        if (derived.skipped !== null) {
          totals.skipped += 1;
          totals.skips[derived.skipped.code] = (totals.skips[derived.skipped.code] ?? 0) + 1;
          console.log(`   ⚠️  ${entry.workspaceId} SKIPPED (${derived.skipped.code}): ${derived.skipped.detail}`);
          continue;
        }

        if (!dryRun) {
          try {
            await writeWorkspace(dbInstance, derived);
          } catch (error) {
            // One workspace's write failing is not a reason to abandon the
            // rest: the run is resumable, so the survivors are progress and
            // this one is a line in the report somebody reads afterwards.
            totals.failed += 1;
            console.log(
              `   ❌ ${entry.workspaceId} WRITE FAILED: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          await sleep(SLEEP_MS);
        }
        totals.written += 1;
        if (!quiet) console.log(`   ${censusLine(derived)}`);
      }
    }

    if (only !== undefined) break;
    if (batch.length < remaining) break;
  }

  report(totals, dryRun);
  return totals;
}

/** Which of these conversation ids still have a row. Absence is reported, never acted on. */
async function loadKnownConversationIds(
  dbInstance: Db,
  conversationIds: readonly string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  for (const chunk of chunked(conversationIds, CHUNK_SIZE)) {
    const rows = await dbInstance
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.id, chunk));
    for (const row of rows) known.add(row.id);
  }
  return known;
}

function recordCensus(totals: BackfillTotals, derived: WorkspaceDerivation): void {
  const census = derived.census;
  totals.panesIn += census.panesIn;
  totals.conversationsIn += census.conversationsIn;
  totals.shellsIn += census.shellsIn;
  totals.membersIn += census.membersIn;
  totals.nodesOut += census.nodesOut;
  totals.paneNodesOut += census.paneNodesOut;
  totals.seatedOut += census.seatedOut;
  totals.membershipDropped += census.membershipDropped;
  for (const note of derived.notes) {
    totals.notes[note.code] = (totals.notes[note.code] ?? 0) + 1;
  }
}

function censusLine(derived: WorkspaceDerivation): string {
  const c = derived.census;
  const notes = derived.notes.length === 0 ? '' : ` · ${derived.notes.map((note) => note.code).join(',')}`;
  return (
    `${c.workspaceId}: panes ${c.panesIn}→${c.paneNodesOut - c.seatedOut}, ` +
    `threads ${c.conversationsIn}, shells ${c.shellsIn}, ` +
    `members ${c.membersIn}→${c.paneNodesOut}, seated ${c.seatedOut}, nodes ${c.nodesOut}${notes}`
  );
}

function report(totals: BackfillTotals, dryRun: boolean): void {
  console.log('');
  console.log(`── census ${dryRun ? '(dry run)' : ''} ─────────────────────────────`);
  console.log(`  live workspaces scanned : ${totals.workspacesScanned}`);
  console.log(`  already migrated (skip) : ${totals.alreadyMigrated}`);
  console.log(`  ${dryRun ? 'would write' : 'written'.padEnd(11)}            : ${totals.written}`);
  console.log(`  skipped (not derivable) : ${totals.skipped}`);
  console.log(`  write failures          : ${totals.failed}`);
  console.log('');
  console.log(`  pane rows in            : ${totals.panesIn}`);
  console.log(`  open conversations in   : ${totals.conversationsIn}`);
  console.log(`  shells in               : ${totals.shellsIn}`);
  console.log(`  members in              : ${totals.membersIn}`);
  console.log(`  pane nodes out          : ${totals.paneNodesOut}`);
  console.log(`  of which seated         : ${totals.seatedOut}`);
  console.log(`  total nodes out         : ${totals.nodesOut}`);
  console.log(`  membership dropped      : ${totals.membershipDropped}`);
  console.log('');
  console.log(`  anomalies : ${JSON.stringify(totals.notes)}`);
  console.log(`  skips     : ${JSON.stringify(totals.skips)}`);

  // The defect condition, stated where a human reading the run will see it.
  // Every member of a workspace becomes exactly one pane node; a difference
  // means a thread lost its node or grew a second one, and neither is a
  // rounding difference.
  if (totals.membersIn !== totals.paneNodesOut) {
    console.log('');
    console.log(`❌ DEFECT: members in (${totals.membersIn}) ≠ pane nodes out (${totals.paneNodesOut})`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const limitArg = valueOf('--limit');

  backfill({
    dryRun: !argv.includes('--apply'),
    limit: limitArg === undefined ? undefined : Number(limitArg),
    only: valueOf('--workspace'),
    quiet: argv.includes('--quiet'),
  })
    .then((totals) => process.exit(totals.membersIn === totals.paneNodesOut ? 0 : 1))
    .catch((error) => {
      console.error('❌ Backfill failed:', error);
      process.exit(1);
    });
}
