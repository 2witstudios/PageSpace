import { after } from 'next/server';
import {
  buildModelContext,
  type CompactionMessage,
  type CompactionState,
} from '@pagespace/lib/ai/context-window';
import { estimateTokens } from '@pagespace/lib/monitoring/ai-context-calculator';
import type { SpendTarget } from '@pagespace/lib/billing/spend-target';
import { canUseCompaction } from './compaction-gating';
import { getState } from './compaction-repository';
import { runCompaction } from './compaction-service';
import type { RunCompactionParams } from './compaction-service';

export interface PrepareConversationContextParams {
  conversationId: string;
  source: 'page' | 'global';
  pageId?: string | null;
  messages: CompactionMessage[];
  model: string;
  provider: string;
  systemPrompt?: string;
  tools?: Record<string, unknown>;
  user: { id: string; role?: string | null } | null | undefined;
  /**
   * Where the turn spends (SPEND-1), with the source its gate resolved pinned. A compaction
   * this turn schedules is gated and reserved on this same target before its own model call
   * (see runCompaction), so it spends where the turn spent or not at all.
   */
  spend: SpendTarget;
}

export interface PreparedContext {
  messages: CompactionMessage[];
  /** Schedule compaction via after() — suitable for top-level route handlers. */
  scheduleCompaction: () => void;
  /**
   * Pending compaction params ready to pass directly to runCompaction().
   * Null when no compaction is needed or the user is not eligible.
   * Use this instead of scheduleCompaction() in tool-execution contexts
   * where after() from next/server is unavailable.
   */
  pendingCompaction: RunCompactionParams | null;
}

export async function prepareConversationContext(
  params: PrepareConversationContextParams
): Promise<PreparedContext> {
  const {
    conversationId,
    source,
    pageId,
    messages,
    model,
    provider,
    systemPrompt,
    tools,
    user,
    spend,
  } = params;

  const noop = () => undefined;

  // Gate: non-admin users get exact legacy behavior
  if (!canUseCompaction(user)) {
    return { messages, scheduleCompaction: noop, pendingCompaction: null };
  }

  // Scoped read: a reused/colliding conversationId must never attach another
  // source's (or another page's) summary to this conversation.
  const compactionRow = await getState(conversationId, { source, pageId });

  const compaction: CompactionState | null = compactionRow
    ? {
        summaryVersion: compactionRow.summaryVersion,
        compactedUpToMessageId: compactionRow.compactedUpToMessageId,
        compactedUpToCreatedAt: compactionRow.compactedUpToCreatedAt,
        summary: compactionRow.summary,
        summaryTokens: compactionRow.summaryTokens,
        lastCompactedAt: compactionRow.lastCompactedAt,
        summarizerModel: compactionRow.summarizerModel,
      }
    : null;

  const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  // JSON.stringify strips function properties (execute closures), so this estimates
  // only the schema/description payload — which is exactly what the model receives.
  const toolTokens = tools ? estimateTokens(JSON.stringify(tools)) : 0;

  const result = buildModelContext({
    messages,
    compaction,
    model,
    provider,
    systemPromptTokens,
    toolTokens,
  });

  const contextMessages: CompactionMessage[] = result.summaryMessage
    ? [result.summaryMessage, ...result.tailMessages]
    : result.tailMessages;

  const pendingCompaction: PreparedContext['pendingCompaction'] =
    result.compactionPlan && user?.id
      ? {
          conversationId,
          source,
          pageId: pageId ?? null,
          userId: user.id,
          provider,
          model,
          plan: result.compactionPlan,
          spend,
        }
      : null;

  const scheduleCompaction = (): void => {
    if (!pendingCompaction) return;
    const params = pendingCompaction;
    after(() => runCompaction(params));
  };

  return { messages: contextMessages, scheduleCompaction, pendingCompaction };
}
