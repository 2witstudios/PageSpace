import { generateText } from 'ai';
import {
  stripNonTextForSummarizer,
  type CompactionMessage,
  type CompactionPlan,
} from '@pagespace/lib/ai/context-window';
import { buildSummarizationPrompt } from '@pagespace/lib/ai/summarization-prompt';
import { estimateTokens } from '@pagespace/lib/monitoring/ai-context-calculator';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { getState, upsertState } from './compaction-repository';

const MIN_GAP_SECONDS = 60;
const MAX_SUMMARY_TOKENS = 4000;

export interface RunCompactionParams {
  conversationId: string;
  source: 'page' | 'global';
  pageId?: string | null;
  userId: string;
  provider: string;
  model: string;
  plan: CompactionPlan;
}

async function summarize(
  model: Awaited<ReturnType<typeof createAIProvider>>,
  messages: CompactionMessage[],
  previousSummary: string | null,
  maxSummaryTokens: number
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // maxSummaryTokens is passed to buildSummarizationPrompt as a token-cap instruction
  if (isProviderError(model)) {
    throw new Error(`Provider error: ${model.error}`);
  }

  const stripped = stripNonTextForSummarizer(messages);
  const { system, prompt } = buildSummarizationPrompt({
    previousSummary,
    transcript: stripped,
    maxSummaryTokens,
  });

  const result = await generateText({
    model: model.model,
    system,
    prompt,
  });

  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

export async function runCompaction(params: RunCompactionParams): Promise<void> {
  const { conversationId, source, pageId, userId, provider, model, plan } = params;

  try {
    const compactionModel = process.env.COMPACTION_MODEL ?? model;

    // Re-check the 60s gap using the live state
    const currentState = await getState(conversationId);
    if (currentState?.lastCompactedAt) {
      const gapMs = Date.now() - currentState.lastCompactedAt.getTime();
      if (gapMs < MIN_GAP_SECONDS * 1000) {
        return; // Too soon — another request already compacted recently
      }
    }

    const providerResult = await createAIProvider(userId, {
      selectedProvider: provider,
      selectedModel: compactionModel,
    });

    if (isProviderError(providerResult)) {
      console.warn('[compaction] provider unavailable:', providerResult.error);
      return;
    }

    const previousSummary = plan.previousSummary ?? currentState?.summary ?? null;
    const messagesToSummarize = plan.messagesToSummarize;

    // For summary-over-cap plans, no new messages — just re-condense the existing summary
    const transcriptMessages: CompactionMessage[] =
      plan.reason === 'summary-over-cap' && messagesToSummarize.length === 0
        ? previousSummary
          ? [{ role: 'user', parts: [{ type: 'text', text: previousSummary }] }]
          : []
        : messagesToSummarize;

    if (transcriptMessages.length === 0 && !previousSummary) {
      return; // Nothing to summarize
    }

    let summaryResult = await summarize(
      providerResult,
      transcriptMessages,
      plan.reason === 'summary-over-cap' ? null : previousSummary,
      MAX_SUMMARY_TOKENS
    );

    // One re-condense pass if output still exceeds cap
    const outputTokens = summaryResult.outputTokens || estimateTokens(summaryResult.text);
    if (outputTokens > MAX_SUMMARY_TOKENS) {
      summaryResult = await summarize(
        providerResult,
        [{ role: 'user', parts: [{ type: 'text', text: summaryResult.text }] }],
        null,
        MAX_SUMMARY_TOKENS
      );
    }

    const summaryTokens =
      summaryResult.outputTokens || estimateTokens(summaryResult.text);

    const expectedVersion =
      plan.currentSummaryVersion ?? currentState?.summaryVersion ?? null;

    const compactedUpToMessageId =
      plan.reason === 'summary-over-cap'
        ? (currentState?.compactedUpToMessageId ?? plan.compactedUpToMessageId)
        : plan.compactedUpToMessageId;

    const compactedUpToCreatedAt =
      plan.reason === 'summary-over-cap'
        ? (currentState?.compactedUpToCreatedAt ?? plan.compactedUpToCreatedAt)
        : plan.compactedUpToCreatedAt;

    const won = await upsertState({
      conversationId,
      source,
      pageId: pageId ?? null,
      summary: summaryResult.text,
      summaryTokens,
      compactedUpToMessageId,
      compactedUpToCreatedAt,
      summarizerModel: compactionModel,
      lastCompactedAt: new Date(),
      expectedVersion: expectedVersion ?? null,
    });

    if (!won) {
      console.debug('[compaction] lost race, discarding result for:', conversationId);
      return;
    }

    await AIMonitoring.trackUsage({
      userId,
      provider,
      model: compactionModel,
      inputTokens: summaryResult.inputTokens,
      outputTokens: summaryResult.outputTokens,
      conversationId,
      pageId: pageId ?? undefined,
      source: 'compaction',
      success: true,
    });
  } catch (err) {
    // Never throw — compaction failures are non-fatal
    console.error('[compaction] failed silently:', err);
  }
}
