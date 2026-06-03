import type { FinishReason, ModelMessage } from 'ai';

/**
 * Pure decision core for the server-side agent retry loop.
 *
 * Given the outcome of a single `streamText` attempt, decide whether the agent
 * finished cleanly, should be retried, or hit a terminal state we must not retry.
 *
 * This module is intentionally IO-free and total over `FinishReason` so it can be
 * exhaustively unit-tested. The imperative retry shell (`run-agent-with-retry.ts`)
 * performs the streaming side effects and just asks this function what to do.
 */

export type RetryReason = 'provider-error' | 'tool-calls-no-finish' | 'ambiguous';
export type TerminalReason =
  | 'length'
  | 'content-filter'
  | 'step-budget'
  | 'aborted'
  | 'provider-error'
  | 'ambiguous';

export type AttemptOutcome =
  | { kind: 'clean' }
  | { kind: 'retry'; reason: RetryReason }
  | { kind: 'terminal'; reason: TerminalReason };

export interface ClassifyAttemptArgs {
  /** Resolved `streamText` finish reason; `undefined` if the attempt threw or the promise rejected. */
  finishReason: FinishReason | undefined;
  /** Any error thrown while consuming the stream (provider disconnect, etc.). */
  caughtError: unknown;
  /** `aiResult.response.messages` from this attempt (assistant + tool messages). */
  responseMessages: ModelMessage[];
  /** Number of steps the attempt ran (`aiResult.steps.length`). */
  stepCount: number;
  /** The `stepCountIs(...)` cap configured on the loop (e.g. 100). */
  maxSteps: number;
  /** The finish-tool name the model calls to signal completion (FINISH_TOOL_NAME). */
  finishToolName: string;
  /** Whether the user explicitly aborted (abortSignal fired). Never retry an abort. */
  aborted: boolean;
  /**
   * Whether this attempt already streamed visible content (text/tool/reasoning parts) to
   * the client. The UI message stream is append-only: a from-scratch retry would duplicate
   * whatever is already on the wire (and re-run any tool whose side effect already ran). So
   * a hard error AFTER content is terminal — we cannot transparently recover it.
   */
  emittedContent: boolean;
}

/**
 * Returns true if any assistant message in this attempt issued a tool call for
 * `finishToolName`. A finish-tool call is the model's explicit "I'm done" signal,
 * so a `tool-calls` finish that includes it is a clean termination.
 *
 * Handles parallel tool calls (finish alongside other calls) and trailing content.
 */
export function calledFinishTool(messages: ModelMessage[], finishToolName: string): boolean {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') continue;
    for (const part of content) {
      if (part.type === 'tool-call' && part.toolName === finishToolName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify a single agent attempt. See the table in the plan/README for the full
 * decision matrix. Key invariant from the AI SDK: a multi-step loop can only end
 * on a `tool-calls` step when `stopWhen` matched (finish tool or step cap) or the
 * stream errored/aborted — so a `tool-calls` finish that is neither the finish
 * tool nor a step-budget exhaustion was cut short and is worth retrying.
 */
export function classifyAttempt(args: ClassifyAttemptArgs): AttemptOutcome {
  // Abort is sacred — a user stop is never retried, regardless of finishReason.
  if (args.aborted) {
    return { kind: 'terminal', reason: 'aborted' };
  }

  // Hard failure: the stream threw, or the provider reported an error finish. A
  // from-scratch retry is only safe if NOTHING was streamed yet — otherwise the
  // partial/garbled output is already committed to the (append-only) message and
  // any executed tool side effect already happened, so we must give up and surface it.
  if (args.caughtError !== undefined || args.finishReason === 'error') {
    return args.emittedContent
      ? { kind: 'terminal', reason: 'provider-error' }
      : { kind: 'retry', reason: 'provider-error' };
  }

  switch (args.finishReason) {
    case 'stop':
      // Natural text termination — the model produced a final message and stopped.
      return { kind: 'clean' };

    case 'tool-calls': {
      if (calledFinishTool(args.responseMessages, args.finishToolName)) {
        return { kind: 'clean' };
      }
      if (args.stepCount >= args.maxSteps) {
        // Ran out of step budget mid-tool-loop — retrying just burns more steps.
        return { kind: 'terminal', reason: 'step-budget' };
      }
      // Ended cleanly on a tool-call step without finish (budget left). The emitted
      // parts are complete/valid, so we re-feed them and CONTINUE — the next attempt
      // appends only new content and won't re-run completed tools (no duplication).
      return { kind: 'retry', reason: 'tool-calls-no-finish' };
    }

    case 'length':
      // Output token cap — a retry truncates identically.
      return { kind: 'terminal', reason: 'length' };

    case 'content-filter':
      // Deterministic — a retry filters identically.
      return { kind: 'terminal', reason: 'content-filter' };

    case 'other':
    case 'unknown':
    case undefined:
    default:
      // Ambiguous provider state. Only retry-from-scratch when nothing was streamed;
      // once content is on the wire, restarting would duplicate it, so stop here.
      return args.emittedContent
        ? { kind: 'terminal', reason: 'ambiguous' }
        : { kind: 'retry', reason: 'ambiguous' };
  }
}
