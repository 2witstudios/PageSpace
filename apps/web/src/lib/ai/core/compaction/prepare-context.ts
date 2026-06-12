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
  scheduleCompaction: () => void;
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
    return { messages, scheduleCompaction: noop };
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

  const scheduleCompaction = (): void => {
    if (!result.compactionPlan || !user?.id) return;
    const plan = result.compactionPlan;
    after(() =>
      runCompaction({
        conversationId,
        source,
        pageId: pageId ?? null,
        userId: user.id,
        provider,
        model,
        plan,
      })
    );
  };

  return { messages: contextMessages, scheduleCompaction };
}
