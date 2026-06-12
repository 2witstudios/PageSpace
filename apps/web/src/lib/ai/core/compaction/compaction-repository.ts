import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { conversationCompactions, type SelectConversationCompaction } from '@pagespace/db/schema/ai-compaction';

export type CompactionStateRow = SelectConversationCompaction;

/**
 * Scope for compaction reads/invalidation. conversationId is the PK, but reused
 * or colliding IDs across sources must never attach another conversation's
 * summary — reads are constrained to the same source (and page for 'page').
 */
export interface CompactionScope {
  source: 'page' | 'global';
  /** The owning page for source 'page'; null/undefined for 'global'. */
  pageId?: string | null;
}

export interface UpsertCompactionParams {
  conversationId: string;
  source: 'page' | 'global';
  pageId?: string | null;
  summary: string;
  summaryTokens: number;
  compactedUpToMessageId: string | null;
  compactedUpToCreatedAt: Date | null;
  summarizerModel: string;
  lastCompactedAt: Date;
  expectedVersion: number | null;
}

export async function getState(
  conversationId: string,
  scope: CompactionScope
): Promise<CompactionStateRow | null> {
  const conditions = [
    eq(conversationCompactions.conversationId, conversationId),
    eq(conversationCompactions.source, scope.source),
  ];
  if (scope.source === 'page' && scope.pageId) {
    conditions.push(eq(conversationCompactions.pageId, scope.pageId));
  }
  const [row] = await db
    .select()
    .from(conversationCompactions)
    .where(and(...conditions));
  return row ?? null;
}

export async function upsertState(params: UpsertCompactionParams): Promise<boolean> {
  const {
    conversationId,
    source,
    pageId,
    summary,
    summaryTokens,
    compactedUpToMessageId,
    compactedUpToCreatedAt,
    summarizerModel,
    lastCompactedAt,
    expectedVersion,
  } = params;

  if (expectedVersion === null) {
    // First insert — onConflictDoNothing: concurrent insert (or an invalidation
    // tombstone written meanwhile) wins, we lose
    const result = await db
      .insert(conversationCompactions)
      .values({
        conversationId,
        source,
        pageId: pageId ?? null,
        summary,
        summaryTokens,
        compactedUpToMessageId,
        compactedUpToCreatedAt,
        summarizerModel,
        lastCompactedAt,
        summaryVersion: 1,
      })
      .onConflictDoNothing();
    return (result.rowCount ?? 0) > 0;
  }

  // Version-guarded update, scoped to the writer's source/page: even if a
  // colliding conversationId carries another scope's row, a matching version
  // must never let this writer overwrite it. (The PK is conversationId alone,
  // so same-id-cross-scope coexistence is intentionally unsupported — a
  // colliding insert is blocked rather than corrupted; see invalidate().)
  const scopeCondition =
    source === 'page' && pageId
      ? sql` AND ${conversationCompactions.source} = ${source} AND ${conversationCompactions.pageId} = ${pageId}`
      : sql` AND ${conversationCompactions.source} = ${source}`;
  const result = await db
    .update(conversationCompactions)
    .set({
      source,
      pageId: pageId ?? null,
      summary,
      summaryTokens,
      compactedUpToMessageId,
      compactedUpToCreatedAt,
      summarizerModel,
      lastCompactedAt,
      summaryVersion: sql`${conversationCompactions.summaryVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      sql`${conversationCompactions.conversationId} = ${conversationId} AND ${conversationCompactions.summaryVersion} = ${expectedVersion}${scopeCondition}`
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Invalidate compaction state by writing an empty-state TOMBSTONE — not a delete.
 *
 * Why a tombstone: if a first compaction is in flight when a pre-pointer message
 * is edited/deleted, a plain DELETE is a no-op (no row exists yet) and the
 * pending null-version insert would land a stale summary afterwards. The
 * tombstone makes that pending insert hit the PK conflict (onConflictDoNothing →
 * lost race) and bumps the version so any pending CAS update misses too.
 *
 * A tombstone row reads as "no compaction": empty summary, null pointers — the
 * context builder sends the full tail. The next over-threshold compaction
 * overwrites it through the normal version-guarded path.
 */
export async function invalidate(
  conversationId: string,
  scope: CompactionScope
): Promise<void> {
  // Step 1: claim the PK if no row exists (atomic; a pending first-compaction
  // insert that arrives later hits this conflict and loses). If another SCOPE
  // already holds the PK, this no-ops — we must not tombstone their state.
  await db
    .insert(conversationCompactions)
    .values({
      conversationId,
      source: scope.source,
      pageId: scope.pageId ?? null,
      summary: '',
      summaryTokens: 0,
      compactedUpToMessageId: null,
      compactedUpToCreatedAt: null,
      summarizerModel: 'invalidated',
      lastCompactedAt: null,
      summaryVersion: 1,
    })
    .onConflictDoNothing();

  // Step 2: clear + version-bump the row, scoped to OUR source/page only.
  // Covers the pre-existing-row case (kills any pending CAS update via the
  // bump) and is a harmless extra bump on the row step 1 just inserted.
  // All interleavings with a concurrent compaction are safe: its insert loses
  // to step 1's row, and its CAS update either lands before step 2 (then gets
  // cleared) or after (version mismatch — discarded).
  const scopeCondition =
    scope.source === 'page' && scope.pageId
      ? sql` AND ${conversationCompactions.source} = ${scope.source} AND ${conversationCompactions.pageId} = ${scope.pageId}`
      : sql` AND ${conversationCompactions.source} = ${scope.source}`;
  await db
    .update(conversationCompactions)
    .set({
      summary: '',
      summaryTokens: 0,
      compactedUpToMessageId: null,
      compactedUpToCreatedAt: null,
      summarizerModel: 'invalidated',
      summaryVersion: sql`${conversationCompactions.summaryVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      sql`${conversationCompactions.conversationId} = ${conversationId}${scopeCondition}`
    );
}
