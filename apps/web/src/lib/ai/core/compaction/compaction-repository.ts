import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { conversationCompactions } from '@pagespace/db/schema/ai-compaction';

export interface CompactionStateRow {
  conversationId: string;
  source: string;
  pageId: string | null;
  summary: string;
  summaryTokens: number;
  compactedUpToMessageId: string | null;
  compactedUpToCreatedAt: Date | null;
  summaryVersion: number;
  summarizerModel: string | null;
  lastCompactedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

export async function getState(conversationId: string): Promise<CompactionStateRow | null> {
  const [row] = await db
    .select()
    .from(conversationCompactions)
    .where(eq(conversationCompactions.conversationId, conversationId));
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
    // First insert — onConflictDoNothing: concurrent insert wins, we lose
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

  // Version-guarded update
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
      sql`${conversationCompactions.conversationId} = ${conversationId} AND ${conversationCompactions.summaryVersion} = ${expectedVersion}`
    );
  return (result.rowCount ?? 0) > 0;
}

export async function invalidate(conversationId: string): Promise<void> {
  await db
    .delete(conversationCompactions)
    .where(eq(conversationCompactions.conversationId, conversationId));
}
