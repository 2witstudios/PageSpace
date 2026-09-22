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
import { pipeUIMessageStreamStrippingStart } from './stream-pipe-utils';

/**
 * Hard cap on agent tool-loop steps per attempt. This single value carries a
 * cross-module invariant: it MUST be both the `stepCountIs(...)` argument in each
 * route's `stopWhen` AND the `maxSteps` passed to `runAgentWithRetry`, because the
 * classifier distinguishes a step-budget terminal from other tool-calls finishes by
 * comparing the step count to it. Keep it here, imported by every consumer, so the
 * three never drift.
 */
export const AGENT_MAX_STEPS = 100;

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
  /**
   * The rewrite `buildStreamText` applies to the messages before the provider sees
   * them (e.g. appending the volatile turn context). Used to price the prompt of a
   * step interrupted by an abort; defaults to the messages as given.
   */
  toSentMessages?: (messages: ModelMessage[]) => ModelMessage[];
  /** The finish-tool name (FINISH_TOOL_NAME). */
  finishToolName: string;
  /** Execute-less tools that pause the turn awaiting user input (e.g. ask_user). */
  pauseToolNames?: string[];
  /** The `stepCountIs(...)` cap configured on the loop (must match the route). */
  maxSteps: number;
  /** Max transparent retries after the first attempt. Default 2 (conservative). */
  maxRetries?: number;
  /** `Date.now()` at request start, for the wall-clock budget. */
  startTimeMs: number;
  /**
   * Stop retrying once elapsed exceeds this (keeps us under the 300s function cap).
   * If you change this default (or any route's `maxDuration`), also check
   * `SANDBOX_MAX_TIMEOUT_MS` (packages/lib/src/services/sandbox/execution-policy.ts)
   * — its cap is sized to leave headroom under this budget for a single bash call.
   */
  maxDurationMs?: number;
  /** Backoff before retry attempt N (0-indexed). Default 0.5s then 1.5s. Injectable for tests. */
  backoffMs?: (attempt: number) => number;
  logger: Logger;
}

/**
 * What the retry shell saw of the step that was still streaming when the run was
 * aborted (user Stop or the credit ceiling). ai@6 reports no usage for that step:
 * `steps`/`totalUsage` only cover finished steps, and a stop during the only step
 * rejects both — so without this the interrupted step settles at $0 although the
 * provider already read its prompt and produced its output. Priced at settle by
 * `agentRunBillingFields` (agent-run-billing.ts).
 */
export interface AbortedStepEstimate {
  /** Text of the messages the aborted attempt sent (system prompt and tools excluded). */
  promptText: string;
  /**
   * Provider-reported input + output tokens of the aborted attempt's last FINISHED
   * step. The interrupted step re-sends that whole context, so it is a floor for its
   * prompt. Absent when no step finished before the abort.
   */
  priorStepContextTokens?: number;
  /** Text, reasoning and tool input streamed for the interrupted step before the abort. */
  outputText: string;
}

export interface RunAgentWithRetryResult {
  /** Concatenation of every attempt's steps — feed to extractOpenRouterCostDollars. */
  accumulatedSteps: ProviderMetadataCarrier[];
  /** Summed usage across attempts. */
  accumulatedUsage: LanguageModelUsage | undefined;
  attempts: number;
  finalOutcome: 'clean' | 'terminal' | 'exhausted';
  terminalReason?: string;
  /** Set only when an abort landed while a step was still streaming. */
  abortedStep?: AbortedStepEstimate;
}

/**
 * Whether this generation was stopped (user Stop, credit gate, or any other abort signal)
 * rather than finishing on its own. Both chat routes' terminal-write call sites (execute-end,
 * onFinish) need this exact check to decide 'interrupted' vs 'complete' — pulled out here so
 * they read it once instead of re-deriving it, since it lives right next to `terminalReason`'s
 * only other producer. See Server Stream Durability epic PR 2.
 */
export function isRunAborted(params: {
  agentRun: Pick<RunAgentWithRetryResult, 'terminalReason'> | undefined;
  abortSignal: AbortSignal;
}): boolean {
  return params.agentRun?.terminalReason === 'aborted' || params.abortSignal.aborted;
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
    // v6 added required token-detail breakdowns to LanguageModelUsage; sum them
    // field-wise so accumulated usage stays a valid LanguageModelUsage across attempts.
    inputTokenDetails: {
      noCacheTokens: num(acc.inputTokenDetails?.noCacheTokens, next.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: num(acc.inputTokenDetails?.cacheReadTokens, next.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: num(acc.inputTokenDetails?.cacheWriteTokens, next.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokenDetails: {
      textTokens: num(acc.outputTokenDetails?.textTokens, next.outputTokenDetails?.textTokens),
      reasoningTokens: num(acc.outputTokenDetails?.reasoningTokens, next.outputTokenDetails?.reasoningTokens),
    },
  };
};

const hasTokenCounts = (usage: LanguageModelUsage | undefined): boolean =>
  usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;

/**
 * The text a model reads from these messages. Image and file data are skipped: their
 * token cost is not proportional to their encoded length.
 */
const messagesText = (messages: ModelMessage[]): string => {
  const out: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text' || part.type === 'reasoning') out.push(part.text);
      else if (part.type === 'tool-call') out.push(JSON.stringify(part.input ?? null));
      else if (part.type === 'tool-result') out.push(JSON.stringify(part.output ?? null));
    }
  }
  return out.join('\n');
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
    toSentMessages = (messages) => messages,
    finishToolName,
    pauseToolNames,
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

  const accumulatedSteps: ProviderMetadataCarrier[] = [];
  let accumulatedUsage: LanguageModelUsage | undefined;
  let attempts = 0;
  let finalOutcome: RunAgentWithRetryResult['finalOutcome'] = 'clean';
  let terminalReason: string | undefined;
  let abortedStep: AbortedStepEstimate | undefined;

  // One envelope around all attempts; inner start/finish are suppressed below.
  safeWrite({ type: 'start' });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    let caughtError: unknown;
    let emittedContent = false;
    // Which step is streaming, and what it has produced so far — read only if an abort
    // lands mid-step (see AbortedStepEstimate).
    let stepOpen = false;
    let finishedStepChunks = 0;
    let inFlightOutput = '';
    const streamedToolInputs = new Set<string>();
    // We only ever retry attempts that streamed NO content (see classifyAttempt:
    // emittedContent), which means no tool ran and nothing was committed — so each
    // attempt safely re-runs from the original baseMessages with no re-feed needed.
    // buildStreamText is invoked INSIDE the try so a synchronous factory throw (bad
    // config) is caught and classified, not allowed to escape the single envelope.
    let aiResult: AgentStreamResult | undefined;
    try {
      aiResult = buildStreamText(baseMessages);
      await pipeUIMessageStreamStrippingStart(aiResult, writer, {
        suppressStart: true,
        suppressFinish: true,
        suppressError: true,
        // Fires even if the stream then throws, so a mid-stream drop AFTER content is
        // correctly classified as unrecoverable (no from-scratch retry → no duplication).
        onContent: () => {
          emittedContent = true;
        },
        onChunk: (chunk) => {
          switch (chunk.type) {
            case 'start-step':
              stepOpen = true;
              inFlightOutput = '';
              streamedToolInputs.clear();
              break;
            case 'finish-step':
              stepOpen = false;
              finishedStepChunks++;
              break;
            case 'text-delta':
            case 'reasoning-delta':
              inFlightOutput += chunk.delta;
              break;
            case 'tool-input-delta':
              streamedToolInputs.add(chunk.toolCallId);
              inFlightOutput += chunk.inputTextDelta;
              break;
            case 'tool-input-available':
              // Providers that do not stream tool input deliver it whole here.
              if (!streamedToolInputs.has(chunk.toolCallId)) {
                inFlightOutput += JSON.stringify(chunk.input ?? null);
              }
              break;
          }
        },
      });
    } catch (error) {
      caughtError = error;
    }

    // The stream may have errored mid-flight (or buildStreamText threw, leaving aiResult
    // undefined); default each field defensively so a failed attempt is classified.
    // v6: streamText result fields are PromiseLike (no `.catch`); wrap in
    // Promise.resolve() to recover full Promise semantics without changing behavior.
    const finishReason: FinishReason | undefined = aiResult
      ? await Promise.resolve(aiResult.finishReason).catch(() => undefined)
      : undefined;
    const responseMessages: ModelMessage[] = aiResult
      ? await Promise.resolve(aiResult.response).then((r) => r.messages).catch(() => [])
      : [];
    const steps: ProviderMetadataCarrier[] = aiResult
      ? await Promise.resolve(aiResult.steps).then((s) => s as ProviderMetadataCarrier[]).catch(() => [])
      : [];
    const usage = aiResult ? await Promise.resolve(aiResult.totalUsage).catch(() => undefined) : undefined;

    // An abort after a step finished resolves `totalUsage` with no token counts (ai@6
    // only fills it from the final `finish` part, which an aborted run never gets), yet
    // each finished step still carries its own usage — sum those instead.
    const stepsUsage = (): LanguageModelUsage | undefined =>
      steps.reduce<LanguageModelUsage | undefined>(
        (acc, step) => mergeUsage(acc, (step as { usage?: LanguageModelUsage }).usage),
        undefined,
      );
    const attemptUsage = abortSignal.aborted && !hasTokenCounts(usage) ? stepsUsage() : usage;

    accumulatedSteps.push(...steps);
    accumulatedUsage = mergeUsage(accumulatedUsage, attemptUsage);

    // The SDK records a step before its `finish-step` chunk reaches us, so an abort
    // landing in between leaves the step "open" here while `steps` already bills it
    // from provider usage. Estimate only a step the SDK has not recorded.
    if (abortSignal.aborted && stepOpen && steps.length <= finishedStepChunks) {
      const priorStepUsage = (steps.at(-1) as { usage?: LanguageModelUsage } | undefined)?.usage;
      abortedStep = {
        promptText: messagesText(toSentMessages(baseMessages)),
        priorStepContextTokens: hasTokenCounts(priorStepUsage)
          ? (priorStepUsage?.inputTokens ?? 0) + (priorStepUsage?.outputTokens ?? 0)
          : undefined,
        outputText: inFlightOutput,
      };
    }

    const outcome = classifyAttempt({
      finishReason,
      caughtError,
      responseMessages,
      stepCount: steps.length,
      maxSteps,
      finishToolName,
      pauseToolNames,
      aborted: abortSignal.aborted,
      emittedContent,
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

    // Abort-aware backoff: resolve immediately if the user stops mid-wait, so we don't
    // keep the request alive for the full delay after a cancellation.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve();
      }, backoffMs(attempt));
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    if (abortSignal.aborted) {
      finalOutcome = 'terminal';
      terminalReason = 'aborted';
      break;
    }
  }

  // Surface a non-network error whenever we give up without a usable result: any retry
  // exhaustion (provider-error / ambiguous / time-budget — these attempts produced no
  // content) or an after-content provider-error terminal. NOT for content-bearing
  // terminals (length / content-filter / step-budget / tool-calls-no-finish), which
  // already streamed a real (if truncated/incomplete) response, nor for user aborts.
  // Phrasing avoids implying a network failure — auto-retry on the client is a manual
  // action now (useStreamRecovery deleted, epic leaf 6.1), so nothing reclassifies this.
  if (finalOutcome === 'exhausted' || terminalReason === 'provider-error') {
    safeWrite({
      type: 'error',
      errorText: 'The assistant could not complete its response. Please try again.',
    });
  }

  safeWrite({ type: 'finish' });

  return { accumulatedSteps, accumulatedUsage, attempts, finalOutcome, terminalReason, abortedStep };
}
