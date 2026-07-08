import { withAdminAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { conversationCompactions } from '@pagespace/db/schema/ai-compaction';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { and, desc, eq, gte, isNotNull, sql } from '@pagespace/db/operators';

// Every summary aggregate shares this ONE window and is computed with SQL
// aggregates over ALL rows in the window — never from a row-limited list.
// Row limits below exist only for the display tables.
const SUMMARY_WINDOW_DAYS = 7;
const RECENT_STATE_LIMIT = 20;
const RECENT_LOGS_LIMIT = 50;

export const GET = withAdminAuth(async () => {
  const since7d = new Date(Date.now() - SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [runStats, stateStats, recent, recentLogs] = await Promise.all([
    // Aggregates over ALL compaction LLM runs (ai_usage_logs) in the window.
    db
      .select({
        count: sql<number>`count(*)::int`,
        totalCostCents: sql<number>`COALESCE(ROUND(SUM(COALESCE(${aiUsageLogs.cost}, 0) * 100)::numeric), 0)::int`,
      })
      .from(aiUsageLogs)
      .where(and(eq(aiUsageLogs.source, 'compaction'), gte(aiUsageLogs.timestamp, since7d))),

    // Aggregates over ALL conversations compacted in the window.
    db
      .select({
        distinctConversations: sql<number>`COUNT(DISTINCT ${conversationCompactions.conversationId})::int`,
        avgSummaryTokens: sql<number>`COALESCE(ROUND(AVG(${conversationCompactions.summaryTokens})), 0)::int`,
      })
      .from(conversationCompactions)
      .where(gte(conversationCompactions.lastCompactedAt, since7d)),

    // Display only: latest compacted-conversation state rows (all time).
    // lastCompactedAt is nullable — never-compacted rows don't belong here.
    db
      .select()
      .from(conversationCompactions)
      .where(isNotNull(conversationCompactions.lastCompactedAt))
      .orderBy(desc(conversationCompactions.lastCompactedAt))
      .limit(RECENT_STATE_LIMIT),

    // Display only: latest runs within the summary window.
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
      .where(and(eq(aiUsageLogs.source, 'compaction'), gte(aiUsageLogs.timestamp, since7d)))
      .orderBy(desc(aiUsageLogs.timestamp))
      .limit(RECENT_LOGS_LIMIT),
  ]);

  const recentWithAge = recent.map((row) => ({
    conversationId: row.conversationId,
    source: row.source,
    summaryTokens: row.summaryTokens,
    summaryVersion: row.summaryVersion,
    summarizerModel: row.summarizerModel,
    lastCompactedAt: row.lastCompactedAt?.toISOString() ?? null,
    ageMinutes: row.lastCompactedAt
      ? Math.round((Date.now() - row.lastCompactedAt.getTime()) / 60_000)
      : null,
  }));

  return Response.json({
    // All summary stats cover the same trailing 7-day window.
    summary: {
      windowDays: SUMMARY_WINDOW_DAYS,
      totalCompactions7d: runStats[0]?.count ?? 0,
      distinctConversationsCompacted7d: stateStats[0]?.distinctConversations ?? 0,
      avgSummaryTokens7d: stateStats[0]?.avgSummaryTokens ?? 0,
      totalCompactionCostCents7d: runStats[0]?.totalCostCents ?? 0,
    },
    recent: recentWithAge,
    recentLogs: recentLogs.map((r) => ({
      conversationId: r.conversationId,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costCents: Math.round((r.cost ?? 0) * 100),
      timestamp: r.timestamp?.toISOString() ?? null,
    })),
    meta: {
      since7d: since7d.toISOString(),
      recentStateLimit: RECENT_STATE_LIMIT,
      recentLogsLimit: RECENT_LOGS_LIMIT,
    },
  });
});
