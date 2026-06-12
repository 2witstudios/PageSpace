import { generateText } from 'ai';
import {
  stripNonTextForSummarizer,
  type CompactionMessage,
  type CompactionPlan,
} from '@pagespace/lib/ai/context-window';
import { normalizeMessageParts, type NormalizableMessage } from '@pagespace/lib/ai/normalize-parts';
import { buildSummarizationPrompt } from '@pagespace/lib/ai/summarization-prompt';
import { estimateTokens } from '@pagespace/lib/monitoring/ai-context-calculator';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { maskIdentifier } from '@/lib/logging/mask';
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
  // Known accepted surface — prompt injection via summarized content: the
  // summarization prompt quotes user rules VERBATIM, so instruction-shaped user
  // text can persist into the stored summary and be re-quoted across future
  // requests until the next recompaction. Mitigations: the summary is injected as
  // a USER message (never system — no elevated trust), it is bounded by
  // maxSummaryTokens, and any pre-pointer edit/delete invalidates and rebuilds it
  // from source history. Revisit if summaries ever gain system-level placement.
  if (isProviderError(model)) {
    throw new Error(`Provider error: ${model.error}`);
  }

  // Normalize SDK-dialect parts (tool-{name}/input/output) to canonical
  // (tool-call/tool-result/args/result) before summarization. This is the
  // ONLY place normalization is applied — convertToModelMessages in the routes
  // requires SDK-dialect parts and cannot receive canonical tool-call/tool-result
  // types (it would extract "call"/"result" as tool names via getToolName).
  const normalized = normalizeMessageParts(messages as NormalizableMessage[]) as CompactionMessage[];
  const stripped = stripNonTextForSummarizer(normalized);
  const { system, prompt } = buildSummarizationPrompt({
    previousSummary,
    transcript: stripped,
    maxSummaryTokens,
  });

  const result = await generateText({
    model: model.model,
    system,
    prompt,
    // Hard output ceiling: the prompt's token-cap instruction is advisory; this
    // bounds the spend and prevents repeated paid summary-over-cap recompactions.
    maxOutputTokens: maxSummaryTokens,
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

    // Re-check the 60s gap using the live state (scoped to this source/page)
    const currentState = await getState(conversationId, { source, pageId });
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
    let totalInputTokens = summaryResult.inputTokens;
    let totalOutputTokens = summaryResult.outputTokens;

    // One re-condense pass if output still exceeds cap
    const outputTokens = summaryResult.outputTokens || estimateTokens(summaryResult.text);
    if (outputTokens > MAX_SUMMARY_TOKENS) {
      summaryResult = await summarize(
        providerResult,
        [{ role: 'user', parts: [{ type: 'text', text: summaryResult.text }] }],
        null,
        MAX_SUMMARY_TOKENS
      );
      totalInputTokens += summaryResult.inputTokens;
      totalOutputTokens += summaryResult.outputTokens;
    }

    // Provider spend has happened — record it now, regardless of whether the
    // summary below wins persistence, passes validation, or loses the race.
    await AIMonitoring.trackUsage({
      userId,
      provider,
      model: compactionModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      conversationId,
      pageId: pageId ?? undefined,
      source: 'compaction',
      success: true,
    });

    // Never persist an empty summary: advancing the pointer with falsy summary
    // text would silently discard all pre-pointer history from the model's view.
    if (!summaryResult.text.trim()) {
      console.warn('[compaction] empty summary generated, state unchanged for:', maskIdentifier(conversationId));
      return;
    }

    let summaryText = summaryResult.text;
    let summaryTokens = summaryResult.outputTokens || estimateTokens(summaryText);

    // Final cap guard: maxOutputTokens bounds real output, but the chars/4
    // estimate can still exceed the cap. Clamp before persistence so the stored
    // summaryTokens can never re-trigger a paid summary-over-cap loop.
    if (summaryTokens > MAX_SUMMARY_TOKENS) {
      summaryText = `${summaryText.slice(0, MAX_SUMMARY_TOKENS * 4)}\n[summary truncated at token cap]`;
      summaryTokens = MAX_SUMMARY_TOKENS;
    }

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
      summary: summaryText,
      summaryTokens,
      compactedUpToMessageId,
      compactedUpToCreatedAt,
      summarizerModel: compactionModel,
      lastCompactedAt: new Date(),
      expectedVersion: expectedVersion ?? null,
    });

    if (!won) {
      // Usage was already tracked above — only the persistence is discarded.
      console.debug('[compaction] lost race, discarding result for:', maskIdentifier(conversationId));
      return;
    }
  } catch (err) {
    // Never throw — compaction failures are non-fatal
    console.error('[compaction] failed silently:', err);
  }
}
