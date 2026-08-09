#!/usr/bin/env bun
/**
 * Backfill Script: every workspace's pane grid and membership → the flat node
 * model (`agent_workspace_nodes`, migration `0255_clear_phil_sheldon.sql`).
 *
 * EVERY workspace, ended ones included — see the scan loop for why an ended
 * workspace is neither finished nor a safe thing to skip.
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
 * **Idempotent and resumable.** A workspace that already holds an
 * `agent_workspace_node_revs` row is skipped whole, so a second run writes
 * nothing and a run resumed after a partial failure continues from where it
 * stopped rather than restarting or skipping ahead. The rev row and not the
 * nodes, because a migrated workspace can legitimately hold zero nodes and must
 * still count as done — see `loadAlreadyMigrated`. Chat targets an earlier run
 * already bound are read back and withheld from this one, so a resume cannot
 * fight the unique index it half-filled.
 *
 * **Dry-run by default.** `--apply` is the only thing that writes. The dry run
 * is the rehearsal: it produces the same per-workspace census a live run does,
 * having derived and validated every workspace, without an INSERT anywhere.
 *
 * **It reads a schema the application no longer has.** The four layout tables
 * and `conversations."workspaceId"` / `"closedInWorkspaceAt"` are gone from
 * `@pagespace/db/schema`, dropped along with the model they belonged to, so
 * this script describes them itself in `scripts/lib/legacy-workspace-layout.ts`
 * — see that file's header. A migration's subject is the schema it is migrating
 * FROM, which by definition stops existing the moment it succeeds.
 *
 * Usage:
 *   bun scripts/backfill-agent-workspace-nodes.ts                 # dry run (default)
 *   bun scripts/backfill-agent-workspace-nodes.ts --workspace ID  # one workspace
 *   bun scripts/backfill-agent-workspace-nodes.ts --limit 100     # first N workspaces
 *   bun scripts/backfill-agent-workspace-nodes.ts --quiet         # totals only
 *   bun scripts/backfill-agent-workspace-nodes.ts --apply         # live write
 *
 * ─── Production procedure ──────────────────────────────────────────────────
 * 1. Ship the release carrying `0255`. `.github/workflows/docker-images.yml`
 *    runs the migration one-shot and THEN deploys web, in that order and with
 *    nothing between them, so the app that reads nodes is live within minutes
 *    of the tables existing.
 * 2. Run this DRY and read the census. **It must exit 0.** A non-zero exit is
 *    one of: a workspace SKIPPED, a write that failed, or members ≠ pane nodes.
 * 3. Run with `--apply` as a one-off machine on the migrate image, and require
 *    exit 0 from that too.
 * 4. Re-run DRY and confirm the census is clean over the whole corpus.
 * 5. ONLY THEN ship the follow-up release carrying `0256`, which drops the
 *    tables this script reads.
 *
 * **STEP 1 IS NOT A QUIET STEP, and the ordering above is why.** The app reads
 * membership only from `agent_workspace_nodes`, with no fallback to the old
 * columns anywhere, so between the deploy and step 3 every pre-existing
 * workspace READS EMPTY. Nothing is lost and step 3 restores all of it — and a
 * WRITE in that window is refused rather than allowed to strand anything
 * (`awaitsBackfill`, answered 503) — but users see empty sessions until the
 * backfill runs, so step 3 belongs immediately after step 1 rather than
 * whenever someone gets to it.
 *
 * The pipeline has an insertion point for automating that (between the
 * "Run migrations" and "Deploy web" steps, which is exactly what step 3's
 * "one-off machine on the migrate image" describes) and deliberately does not
 * use it: no backfill in this repo runs from a deploy, and making this the
 * first would put a full-corpus scan on every subsequent deploy for a window
 * that closes once.
 *
 * **Step 4's exit code is the gate on step 5, and this is the whole reason the
 * order matters.** A skipped workspace does NOT stay safely on the old model —
 * 0256 deletes the old model. It loses its grid outright, and its threads,
 * belonging to no node, read as homeless and become claimable into a DIFFERENT
 * workspace. DO NOT run this against production yourself — document only.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { getMigrationDb } from '@pagespace/db/db';
import { agentWorkspaces, agentWorkspaceShells } from '@pagespace/db/schema/agent-workspaces';
import { agentWorkspaceNodes, agentWorkspaceNodeRevs } from '@pagespace/db/schema/agent-workspace-nodes';
import { and, asc, eq, gt, inArray, isNotNull, isNull } from '@pagespace/db/operators';
import {
  deriveWorkspaceNodes,
  resolveChatClaims,
  type ChatPaneReference,
  type WorkspaceBackfillSource,
  type WorkspaceDerivation,
} from '@pagespace/lib/agent-workspaces/workspace-node-backfill';
import {
  legacyConversations,
  legacyPaneColumns,
  legacyPanes,
} from './lib/legacy-workspace-layout';
import {
  censusLine,
  emptyTotals,
  formatReport,
  recordNotWritten,
  recordWritten,
  runIsClean,
  type BackfillTotals,
} from './lib/backfill-census';

export type { BackfillTotals };

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
      workspaceId: legacyPanes.workspaceId,
      conversationId: legacyPanes.targetId,
    })
    .from(legacyPanes)
    .innerJoin(agentWorkspaces, eq(agentWorkspaces.id, legacyPanes.workspaceId))
    .where(
      and(
        eq(legacyPanes.kind, 'chat'),
        isNotNull(legacyPanes.targetId),
      ),
    );

  const references: ChatPaneReference[] = paneRows
    .filter((row): row is { workspaceId: string; conversationId: string } => row.conversationId !== null)
    .map((row) => ({ workspaceId: row.workspaceId, conversationId: row.conversationId }));

  const targetIds = [...new Set(references.map((reference) => reference.conversationId))];

  // Who has an UNCONDITIONAL claim: a conversation whose workspace still exists
  // and will emit a membership node for it. "Open" is `countOpenConversations`' predicate,
  // spelled the same way here on purpose — bound, `isActive`, and not closed
  // out of the session's listing.
  const membershipOwner = new Map<string, string>();
  for (const chunk of chunked(targetIds, CHUNK_SIZE)) {
    const owners = await dbInstance
      .select({ conversationId: legacyConversations.id, workspaceId: legacyConversations.workspaceId })
      .from(legacyConversations)
      .innerJoin(agentWorkspaces, eq(agentWorkspaces.id, legacyConversations.workspaceId))
      .where(
        and(
          inArray(legacyConversations.id, chunk),
          eq(legacyConversations.isActive, true),
          isNull(legacyConversations.closedInWorkspaceAt),
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
        workspaceId: legacyPaneColumns.workspaceId,
        id: legacyPaneColumns.id,
        orderIndex: legacyPaneColumns.orderIndex,
        widthFraction: legacyPaneColumns.widthFraction,
      })
      .from(legacyPaneColumns)
      .where(inArray(legacyPaneColumns.workspaceId, workspaceIds)),
    // EVERY pane row of the workspace, unfiltered — deliberately, and it is not
    // the loophole it looks like. Which panes may be materialised is decided by
    // `loadOpenConversationIds` below and applied inside the derivation, where
    // dropping one also renumbers its siblings, empties or collapses its column
    // and re-settles the shares. Filtering here instead would delete the row
    // from the geometry without any of that, and `panesIn` would then count
    // only the survivors — leaving the census unable to show an operator the
    // difference between a workspace that had two panes and a workspace that
    // lost two.
    dbInstance
      .select({
        workspaceId: legacyPanes.workspaceId,
        id: legacyPanes.id,
        columnId: legacyPanes.columnId,
        orderIndex: legacyPanes.orderIndex,
        kind: legacyPanes.kind,
        targetId: legacyPanes.targetId,
        heightFraction: legacyPanes.heightFraction,
      })
      .from(legacyPanes)
      .where(inArray(legacyPanes.workspaceId, workspaceIds)),
    // The membership predicate, identical to `countOpenConversations`': bound,
    // history-alive, and not closed out of the session's listing. A thread the
    // user dismissed is deliberately NOT a member — materialising it as a
    // detached node would reopen every thread everyone ever closed.
    dbInstance
      .select({
        workspaceId: legacyConversations.workspaceId,
        id: legacyConversations.id,
        createdAt: legacyConversations.createdAt,
      })
      .from(legacyConversations)
      .where(
        and(
          inArray(legacyConversations.workspaceId, workspaceIds),
          eq(legacyConversations.isActive, true),
          isNull(legacyConversations.closedInWorkspaceAt),
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

/**
 * Workspaces a run has ALREADY been through — by the rev row, not by the nodes.
 *
 * The question is "has the backfill been here", and it has to be MONOTONIC: a
 * workspace that has been migrated must never read as outstanding again, or a
 * re-run does the work twice. `agent_workspace_node_revs` answers it and the
 * node rows do not. `writeWorkspace` mints the rev in the same transaction as
 * the nodes, `writeWorkspaceNodes` only ever increments it, and nothing deletes
 * it — a `destroy` takes the nodes and leaves the rev standing. So every
 * workspace that holds a node holds a rev, and the reverse does not follow.
 *
 * Asking "does it hold nodes?" is the same non-monotonic mistake `awaitsBackfill`
 * made on the other side of this cutover, and the divergence is not exotic:
 * `endSession` empties a tree, which is an ordinary thing for a live workspace
 * to be. Keyed on nodes, a re-run then finds a migrated workspace with none,
 * calls it outstanding, and re-derives it from legacy rows that are still
 * there — nothing writes `conversations.workspaceId` or `closedInWorkspaceAt`
 * any more, so no node-model action can retire them. The census (step 2 in the
 * procedure above, and the gate on the destructive 0256) reports a workspace it
 * has already done as outstanding, and `--apply` resurrects the tree the user
 * ended — without bumping the rev, since that insert is `onConflictDoNothing`,
 * so no live client learns the rows came back.
 */
async function loadAlreadyMigrated(dbInstance: Db, workspaceIds: string[]): Promise<Set<string>> {
  const rows = await dbInstance
    .select({ rootId: agentWorkspaceNodeRevs.rootId })
    .from(agentWorkspaceNodeRevs)
    .where(inArray(agentWorkspaceNodeRevs.rootId, workspaceIds));
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
  /** Stop after this many workspaces. Omitted means all of them. */
  limit?: number;
  /** Derive exactly one workspace, by id — the shape a post-mortem needs. */
  only?: string;
  /** Suppress the per-workspace lines and print only the totals. */
  quiet?: boolean;
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
    /*
     * EVERY workspace, ended ones included. This used to be
     * `isNull(agentWorkspaces.endedAt)`, on the reasoning that an ended
     * workspace is finished and not worth migrating. Two things make that
     * wrong, and the second one is data loss:
     *
     *  - An ended workspace can be UN-ENDED. `planSessionReopen` clears
     *    `endedAt` when a thread is claimed into it, so "ended" is not a
     *    terminal state and the set this scan skipped was never stable.
     *  - `0256` drops `conversations.workspaceId`. A thread whose only record of
     *    membership is that column, in a workspace this scan skipped, becomes a
     *    thread belonging to nothing — reachable only through past-conversation
     *    history — and the census exits 0 over it, because a workspace that was
     *    never scanned cannot be reported as unmigrated.
     *
     * Migrating them costs a handful of rows per workspace and makes the
     * corpus this script walks the same set the drop will affect, which is the
     * only scope under which "census clean" means "nothing will be lost".
     */
    const conditions = [];
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
      const [knownConversationIds, openConversationIds, claimedChatTargets] = await Promise.all([
        loadKnownConversationIds(dbInstance, batchChatTargets),
        loadOpenConversationIds(dbInstance, batchChatTargets),
        loadClaimedChatTargets(dbInstance, batchChatTargets),
      ]);

      for (const entry of sources) {
        const derived = deriveWorkspaceNodes(entry, {
          chatClaims,
          claimedChatTargets,
          knownConversationIds,
          openConversationIds,
        });

        // NOTHING is counted into the headline totals until it has actually
        // been written. `recordCensus` used to run here, before the skip check,
        // so a workspace that wrote nothing still contributed its members and
        // its nodes — and since the defect assertion compares two of those same
        // numbers, a skip inflated both sides equally and hid itself from the
        // one automated check the run makes.
        if (derived.skipped !== null) {
          recordNotWritten(totals, derived, {
            reason: 'skipped',
            code: derived.skipped.code,
            detail: derived.skipped.detail,
          });
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
            const message = error instanceof Error ? error.message : String(error);
            recordNotWritten(totals, derived, {
              reason: 'write_failed',
              code: error instanceof Error ? error.name : 'Error',
              detail: message,
            });
            console.log(`   ❌ ${entry.workspaceId} WRITE FAILED: ${message}`);
            continue;
          }
          await sleep(SLEEP_MS);
        }
        recordWritten(totals, derived);
        if (!quiet) console.log(`   ${censusLine(derived)}`);
      }
    }

    if (only !== undefined) break;
    if (batch.length < remaining) break;
  }

  for (const reportLine of formatReport(totals, dryRun)) console.log(reportLine);
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
      .select({ id: legacyConversations.id })
      .from(legacyConversations)
      .where(inArray(legacyConversations.id, chunk));
    for (const row of rows) known.add(row.id);
  }
  return known;
}

/**
 * Which of these conversations are MEMBERS of anything — the same predicate
 * `loadSources` applies to the membership load, spelled the same way, and
 * resolved over the conversations the PANE rows name as well.
 *
 * This is the query that was missing, and it is the only finding on this
 * migration's list that could not have been corrected afterwards. Closing a
 * thread out of a workspace stamped `closedInWorkspaceAt` and nothing on the
 * server ever removed its pane row, so a live pane bound to a dismissed thread
 * is ordinary production data — and post-cutover, membership IS the node. The
 * membership load filtered; the pane load did not; so at the moment of
 * migration every thread every user had ever dismissed would have become a
 * member again AND been placed on the grid. After the run there is no way to
 * tell such a thread from one that was genuinely open, because the column that
 * knew is dropped by 0256.
 *
 * NOT scoped to any workspace. A pane may name a conversation in another
 * session (the old rows carry no constraint against it), so the question is
 * "is this thread a member anywhere", not "is it a member here" — and the claim
 * pre-pass has already decided who may bind it if it is.
 */
async function loadOpenConversationIds(
  dbInstance: Db,
  conversationIds: readonly string[],
): Promise<Set<string>> {
  const open = new Set<string>();
  for (const chunk of chunked(conversationIds, CHUNK_SIZE)) {
    const rows = await dbInstance
      .select({ id: legacyConversations.id })
      .from(legacyConversations)
      .where(
        and(
          inArray(legacyConversations.id, chunk),
          eq(legacyConversations.isActive, true),
          isNull(legacyConversations.closedInWorkspaceAt),
        ),
      );
    for (const row of rows) open.add(row.id);
  }
  return open;
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
    // `runIsClean` is the gate on migration 0256 — one definition, read by the
    // report and by the exit code, so the banner a human sees and the status an
    // automation checks can never disagree.
    .then((totals) => process.exit(runIsClean(totals) ? 0 : 1))
    .catch((error) => {
      console.error('❌ Backfill failed:', error);
      process.exit(1);
    });
}
