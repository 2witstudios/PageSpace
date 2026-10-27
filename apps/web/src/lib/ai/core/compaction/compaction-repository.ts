import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { conversationCompactions, type SelectConversationCompaction } from '@pagespace/db/schema/ai-compaction';

export type CompactionStateRow = SelectConversationCompaction;

/**
 * Scope for compaction reads/invalidation. The composite PK (conversationId, source)
 * allows page and global compaction rows to coexist for the same conversationId.
 * Per-page isolation (when source = 'page') is still enforced by a pageId predicate
 * since pageId is nullable and not part of the PK.
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
    // First insert — onConflictDoNothing: the composite PK (conversationId, source)
    // ensures a concurrent insert for the same scope loses; a different scope's row
    // is a distinct key slot and is unaffected.
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

  // Version-guarded CAS update, scoped to the writer's (source, pageId).
  // Composite PK ensures only this scope's row is reachable by conversationId + source.
  const updateConditions = [
    eq(conversationCompactions.conversationId, conversationId),
    eq(conversationCompactions.summaryVersion, expectedVersion),
    eq(conversationCompactions.source, source),
  ];
  if (source === 'page' && pageId) {
    updateConditions.push(eq(conversationCompactions.pageId, pageId));
  }
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
    .where(and(...updateConditions));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Invalidate compaction state by writing an empty-state TOMBSTONE — not a delete.
 *
 * Why a tombstone: if a first compaction is in flight when a pre-pointer message
 * is edited/deleted, a plain DELETE is a no-op (no row exists yet) and the
 * pending null-version insert would land a stale summary afterwards. The
 * tombstone makes that pending insert hit the composite-PK conflict
 * (onConflictDoNothing → lost race) and bumps the version so any pending CAS
 * update misses too.
 *
 * A tombstone row reads as "no compaction": empty summary, null pointers — the
 * context builder sends the full tail. The next over-threshold compaction
 * overwrites it through the normal version-guarded path.
 *
 * Cross-scope isolation: the composite PK (conversationId, source) means each
 * scope owns its own key slot. Tombstoning 'page' never touches the 'global'
 * row for the same conversationId, and vice versa.
 */
export async function invalidate(
  conversationId: string,
  scope: CompactionScope
): Promise<void> {
  // Step 1: claim the (conversationId, source) composite key slot for this scope
  // if no row exists yet. A pending first-compaction insert that arrives later
  // hits this conflict and loses. A different scope's row is a distinct key slot
  // and is unaffected — scopes are independently owned.
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

  // Step 2: clear + version-bump the row, scoped to OUR (source, pageId) only.
  // Covers the pre-existing-row case (kills any pending CAS update via the
  // bump) and is a harmless extra bump on the row step 1 just inserted.
  // All interleavings with a concurrent compaction are safe: its insert loses
  // to step 1's row, and its CAS update either lands before step 2 (then gets
  // cleared) or after (version mismatch — discarded).
  const clearConditions = [
    eq(conversationCompactions.conversationId, conversationId),
    eq(conversationCompactions.source, scope.source),
  ];
  if (scope.source === 'page' && scope.pageId) {
    clearConditions.push(eq(conversationCompactions.pageId, scope.pageId));
  }
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
    .where(and(...clearConditions));
}
