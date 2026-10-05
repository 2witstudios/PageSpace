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
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { callAdmission } from '@pagespace/lib/billing/call-admission';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import type { SpendTarget } from '@pagespace/lib/billing/spend-target';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { gateUserCall } from '@/lib/ai/core/user-credit-hold';
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
  /**
   * Where the turn this compaction belongs to spent (SPEND-1), with the source its gate
   * resolved pinned (resolvedSpend). A compaction is a model call of its own, so it is gated
   * and reserved on this same target before the model runs, and settles once on the wallet
   * that reservation names: a mention reply's compaction on the drive wallet or not at all,
   * never the sender's own credits (SPEND-6).
   */
  spend: SpendTarget;
  /**
   * The consumer the turn's gate bound, when it is not `userId` (a manual workflow Run's presser): the compaction is
   * gated and its usage recorded as them, so it counts toward their cap (review #2817 P2-3). `userId` still picks the
   * provider and owns the conversation.
   */
  billedUserId?: string;
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
  const { conversationId, source, pageId, userId, provider, model, plan, spend } = params;
  const billedUserId = params.billedUserId ?? userId;

  // The reservation this compaction runs against. trackUsage takes it over at settle; every
  // path that ends before that releases it in `finally`, so a refused, failed or empty run
  // never strands a hold.
  let holdId: string | undefined;
  let holdHandedOff = false;

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
    // What actually runs: the factory can substitute the metered default when the compaction
    // model does not fit the requested provider, so admission and the settle key on this,
    // never on the requested (possibly exempt) provider.
    const runProvider = providerResult.provider;
    const runModel = providerResult.modelName;

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

    // Gate BEFORE the model (SPEND-1): reserve on the turn's own target. A refusal (an empty
    // or paused wallet, an exhausted balance) skips the compaction entirely: no model call,
    // no charge, and the stored summary and pointer stay exactly as they were, so the
    // conversation keeps working from the context it already had.
    const admission = callAdmission({
      meteringExempt: isMeteringExempt(runProvider),
      spend,
      estCostCents: estimateChatHoldCentsForModel(runModel, {
        inputTokens: estimateTokens(JSON.stringify(transcriptMessages)) + (previousSummary ? estimateTokens(previousSummary) : 0),
      }),
    });
    let walletId: string | undefined;
    if (admission.gate) {
      const gate = await gateUserCall(billedUserId, { spend: admission.spend, estCostCents: admission.estCostCents });
      if (!gate.allowed) {
        console.info('[compaction] refused by the credit gate, state unchanged:', gate.reason, maskIdentifier(conversationId));
        return;
      }
      holdId = gate.holdId;
      walletId = gate.walletId;
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let settled = false;
    // One settle per compaction, on the hold and wallet the gate named. Provider spend that
    // happened is recorded whether or not the summary below wins persistence, passes
    // validation, loses the race, or a re-condense pass fails after the first one was paid.
    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      holdHandedOff = true;
      await AIMonitoring.trackUsage({
        userId: billedUserId,
        provider: runProvider,
        model: runModel,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        conversationId,
        pageId: pageId ?? undefined,
        source: 'compaction',
        holdId,
        walletId,
        success: true,
      });
    };

    let summaryResult: Awaited<ReturnType<typeof summarize>>;
    try {
      summaryResult = await summarize(
        providerResult,
        transcriptMessages,
        plan.reason === 'summary-over-cap' ? null : previousSummary,
        MAX_SUMMARY_TOKENS
      );
      totalInputTokens = summaryResult.inputTokens;
      totalOutputTokens = summaryResult.outputTokens;

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
    } catch (err) {
      // A pass that was paid for before a later one failed still settles; nothing persists.
      if (totalInputTokens + totalOutputTokens > 0) await settle();
      throw err;
    }

    await settle();

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
  } finally {
    if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
  }
}
