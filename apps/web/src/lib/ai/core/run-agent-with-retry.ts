import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  StreamTextResult,
  ToolSet,
  UIMessageChunk,
  UIMessageStreamWriter,
} from 'ai';
import type { ProviderMetadataCarrier } from '@pagespace/lib/monitoring/ai-monitoring';
import { classifyAttempt } from './agent-finish-classifier';
import { reconcileInterruptedToolCalls } from './reconcile-interrupted-tool-calls';
import { pipeUIMessageStreamStrippingStart } from './stream-pipe-utils';

/** Minimal shape of a `streamText` result the retry shell consumes. */
export type AgentStreamResult = Pick<
  StreamTextResult<ToolSet, never>,
  'toUIMessageStream' | 'finishReason' | 'response' | 'steps' | 'totalUsage'
>;

interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RunAgentWithRetryParams {
  writer: UIMessageStreamWriter;
  abortSignal: AbortSignal;
  /** Conversation history the first attempt runs on (ModelMessage[]). */
  baseMessages: ModelMessage[];
  /**
   * Factory that builds a `streamText` call for the given messages. The caller owns
   * all route-specific config (model, system, tools, experimental_context, onChunk →
   * multicast, onAbort, maxRetries). The shell only swaps `messages` per attempt.
   */
  buildStreamText: (messages: ModelMessage[]) => AgentStreamResult;
  /** The finish-tool name (FINISH_TOOL_NAME). */
  finishToolName: string;
  /** The `stepCountIs(...)` cap configured on the loop (must match the route). */
  maxSteps: number;
  /** Max transparent retries after the first attempt. Default 2 (conservative). */
  maxRetries?: number;
  /** `Date.now()` at request start, for the wall-clock budget. */
  startTimeMs: number;
  /** Stop retrying once elapsed exceeds this (keeps us under the 300s function cap). */
  maxDurationMs?: number;
  /** Backoff before retry attempt N (0-indexed). Default 0.5s then 1.5s. Injectable for tests. */
  backoffMs?: (attempt: number) => number;
  logger: Logger;
}

export interface RunAgentWithRetryResult {
  /** Concatenation of every attempt's steps — feed to extractOpenRouterCostDollars. */
  accumulatedSteps: ProviderMetadataCarrier[];
  /** Summed usage across attempts. */
  accumulatedUsage: LanguageModelUsage | undefined;
  attempts: number;
  finalOutcome: 'clean' | 'terminal' | 'exhausted';
  terminalReason?: string;
}

const num = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
};

const mergeUsage = (
  acc: LanguageModelUsage | undefined,
  next: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined => {
  if (!next) return acc;
  if (!acc) return next;
  return {
    inputTokens: num(acc.inputTokens, next.inputTokens),
    outputTokens: num(acc.outputTokens, next.outputTokens),
    totalTokens: num(acc.totalTokens, next.totalTokens),
    reasoningTokens: num(acc.reasoningTokens, next.reasoningTokens),
    cachedInputTokens: num(acc.cachedInputTokens, next.cachedInputTokens),
  };
};

/**
 * Run the agent loop with conservative, server-side, in-request retries.
 *
 * The loop lives INSIDE createUIMessageStream's `execute`, so `onFinish` still fires
 * exactly once after this resolves — the one-hold / one-settle billing invariant is
 * preserved. Steps are accumulated across attempts so billing reflects the real
 * provider cost of every attempt (we were charged for those tokens) without
 * double-charging (a single trackUsage → single consumeCredits settles once).
 *
 * Emits a single message envelope (one `start`, one `finish`) regardless of attempt
 * count; per-attempt errors are suppressed and only a terminal give-up surfaces an
 * error part to the client.
 */
export async function runAgentWithRetry(
  params: RunAgentWithRetryParams,
): Promise<RunAgentWithRetryResult> {
  const {
    writer,
    abortSignal,
    baseMessages,
    buildStreamText,
    finishToolName,
    maxSteps,
    maxRetries = 2,
    startTimeMs,
    maxDurationMs = 285_000,
    backoffMs = (attempt) => (attempt === 0 ? 500 : 1500),
    logger,
  } = params;

  const safeWrite = (chunk: UIMessageChunk): void => {
    try {
      writer.write(chunk);
    } catch {
      // Client disconnected — keep going so onFinish/billing still run.
    }
  };

  let messages = baseMessages;
  const accumulatedSteps: ProviderMetadataCarrier[] = [];
  let accumulatedUsage: LanguageModelUsage | undefined;
  let attempts = 0;
  let finalOutcome: RunAgentWithRetryResult['finalOutcome'] = 'clean';
  let terminalReason: string | undefined;

  // One envelope around all attempts; inner start/finish are suppressed below.
  safeWrite({ type: 'start' });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    const aiResult = buildStreamText(messages);

    let caughtError: unknown;
    try {
      await pipeUIMessageStreamStrippingStart(aiResult, writer, {
        suppressStart: true,
        suppressFinish: true,
        suppressError: true,
      });
    } catch (error) {
      caughtError = error;
    }

    const finishReason: FinishReason | undefined = await aiResult.finishReason.catch(
      () => undefined,
    );
    const response = await aiResult.response.catch(() => ({ messages: [] as ModelMessage[] }));
    const steps = await aiResult.steps.catch(() => [] as unknown[]);
    const usage = await aiResult.totalUsage.catch(() => undefined);

    accumulatedSteps.push(...(steps as unknown as ProviderMetadataCarrier[]));
    accumulatedUsage = mergeUsage(accumulatedUsage, usage);

    const responseMessages = response.messages as ModelMessage[];
    const outcome = classifyAttempt({
      finishReason,
      caughtError,
      responseMessages,
      stepCount: steps.length,
      maxSteps,
      finishToolName,
      aborted: abortSignal.aborted,
    });

    if (outcome.kind === 'clean') {
      finalOutcome = 'clean';
      break;
    }
    if (outcome.kind === 'terminal') {
      finalOutcome = 'terminal';
      terminalReason = outcome.reason;
      break;
    }

    // outcome.kind === 'retry'
    if (abortSignal.aborted) {
      finalOutcome = 'terminal';
      terminalReason = 'aborted';
      break;
    }
    if (attempt >= maxRetries) {
      finalOutcome = 'exhausted';
      terminalReason = outcome.reason;
      break;
    }
    const elapsed = Date.now() - startTimeMs;
    if (elapsed >= maxDurationMs) {
      finalOutcome = 'exhausted';
      terminalReason = 'time-budget';
      logger.warn('runAgentWithRetry: wall-clock budget exhausted, not retrying', { elapsed });
      break;
    }

    logger.info('runAgentWithRetry: retrying agent loop', {
      attempt: attempt + 1,
      reason: outcome.reason,
      elapsedMs: elapsed,
    });

    // Re-feed: append this attempt's turn, injecting synthetic results for any
    // interrupted tool-calls so the next attempt does not re-run mutating tools.
    messages = reconcileInterruptedToolCalls([...messages, ...responseMessages]);

    await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    if (abortSignal.aborted) {
      finalOutcome = 'terminal';
      terminalReason = 'aborted';
      break;
    }
  }

  // Surface a TERMINAL, non-network error on provider-error give-up. Phrasing avoids the
  // client's isNetworkError patterns so useStreamRecovery does not re-run on top of us.
  if (finalOutcome === 'exhausted' && terminalReason === 'provider-error') {
    safeWrite({
      type: 'error',
      errorText:
        'The assistant could not complete its response after several attempts. Please try again.',
    });
  }

  safeWrite({ type: 'finish' });

  return { accumulatedSteps, accumulatedUsage, attempts, finalOutcome, terminalReason };
}
