import { after } from 'next/server';
import {
  buildModelContext,
  type CompactionMessage,
  type CompactionState,
} from '@pagespace/lib/ai/context-window';
import { estimateTokens } from '@pagespace/lib/monitoring/ai-context-calculator';
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
  } = params;

  const noop = () => undefined;

  // Gate: non-admin users get exact legacy behavior
  if (!canUseCompaction(user)) {
    return { messages, scheduleCompaction: noop, pendingCompaction: null };
  }

  const compactionRow = await getState(conversationId);

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
        }
      : null;

  const scheduleCompaction = (): void => {
    if (!pendingCompaction) return;
    const params = pendingCompaction;
    after(() => runCompaction(params));
  };

  return { messages: contextMessages, scheduleCompaction, pendingCompaction };
}
