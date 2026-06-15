import { withAdminAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { conversationCompactions } from '@pagespace/db/schema/ai-compaction';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { and, desc, eq, gte, sql } from '@pagespace/db/operators';

async function handleCompactionStats(): Promise<Response> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [recent, total7d, compactionLogs] = await Promise.all([
    // 20 most recently compacted conversations
    db
      .select()
      .from(conversationCompactions)
      .orderBy(desc(conversationCompactions.lastCompactedAt))
      .limit(20),

    // Count of distinct compacted conversations updated in last 7 days
    db
      .select({ count: sql<number>`count(*)` })
      .from(conversationCompactions)
      .where(gte(conversationCompactions.lastCompactedAt, since7d)),

    // Usage log rows for compaction model runs in last 24h
    db
      .select({
        conversationId: aiUsageLogs.conversationId,
        model: aiUsageLogs.model,
        inputTokens: aiUsageLogs.inputTokens,
        outputTokens: aiUsageLogs.outputTokens,
        cost: aiUsageLogs.cost,
        timestamp: aiUsageLogs.timestamp,
      })
      .from(aiUsageLogs)
      .where(and(eq(aiUsageLogs.source, 'compaction'), gte(aiUsageLogs.timestamp, since24h)))
      .orderBy(desc(aiUsageLogs.timestamp))
      .limit(50),
  ]);

  const compactionCount7d = Number(total7d[0]?.count ?? 0);

  // Aggregate cost across the 24h compaction run window
  const totalCompactionCostCents = compactionLogs.reduce(
    (sum, r) => sum + Math.round((r.cost ?? 0) * 100),
    0,
  );
  const avgSummaryTokens =
    recent.length > 0
      ? Math.round(recent.reduce((s, r) => s + (r.summaryTokens ?? 0), 0) / recent.length)
      : 0;

  // Gate coverage: how many distinct conversations have been compacted
  const distinctConversations = new Set(recent.map((r) => r.conversationId)).size;

  const recentWithAge = recent.map((row) => ({
    conversationId: row.conversationId,
    source: row.source,
    summaryTokens: row.summaryTokens,
    summaryVersion: row.summaryVersion,
    summarizerModel: row.summarizerModel,
    lastCompactedAt: row.lastCompactedAt?.toISOString() ?? null,
    compactedUpToCreatedAt: row.compactedUpToCreatedAt?.toISOString() ?? null,
    ageMinutes: row.lastCompactedAt
      ? Math.round((Date.now() - row.lastCompactedAt.getTime()) / 60_000)
      : null,
  }));

  return Response.json({
    summary: {
      totalCompactions7d: compactionCount7d,
      distinctConversationsCompacted: distinctConversations,
      avgSummaryTokens,
      totalCompactionCostCents,
      compactionLogsSince24h: compactionLogs.length,
    },
    recent: recentWithAge,
    recentLogs: compactionLogs.map((r) => ({
      conversationId: r.conversationId,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costCents: Math.round((r.cost ?? 0) * 100),
      timestamp: r.timestamp?.toISOString() ?? null,
    })),
    meta: { since24h: since24h.toISOString(), since7d: since7d.toISOString() },
  });
}

export async function GET(request: Request): Promise<Response> {
  return withAdminAuth(async () => handleCompactionStats())(request);
}
