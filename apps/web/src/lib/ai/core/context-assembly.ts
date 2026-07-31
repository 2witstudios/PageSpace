/**
 * Unified history-preparation seam.
 *
 * Centralizes the three-step pipeline that every chat route must run before
 * passing messages to the model:
 *
 *   sanitizeMessagesForModel
 *     → prepareConversationContext   (sliding-window compaction, admin-gated)
 *     → elideStaleToolOutputs        (stale read-tool outputs → deterministic stub)
 *
 * Returns the elided UIMessage tail plus metadata needed by each route
 * (summaryText, stableBoundaryIndex for cache breakpoints, scheduleCompaction).
 * Routes call finishModelRequest to convert the tail and prepend the summary —
 * the one owned seam between the seam output and streamText/generateText input.
 */

import { convertToModelMessages, type UIMessage, type ToolSet, type ModelMessage } from 'ai';
import { sanitizeMessagesForModel } from '@/lib/ai/core/message-utils';
import {
  prepareConversationContext,
  type PrepareConversationContextParams,
  type PreparedContext,
} from '@/lib/ai/core/compaction/prepare-context';
import {
  isSyntheticSummaryMessage,
  type CompactionMessage,
} from '@pagespace/lib/ai/context-window';
import {
  computeElisionBoundary,
  elideStaleToolOutputs,
  DEFAULT_ELIDABLE_TOOLS,
  type ElisionMessage,
} from '@pagespace/lib/ai/tool-result-eliding';
import { WRITE_TOOLS } from '@/lib/ai/core/tool-filtering';

// ─── Elision config ────────────────────────────────────────────────────────────

const ELISION_KEEP_LAST_TURNS = 4;
const ELISION_CHUNK_SIZE = 8;
const ELISION_MIN_OUTPUT_CHARS = 1000;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PrepareHistoryParams extends Omit<PrepareConversationContextParams, 'messages'> {
  /** Full UIMessage history as loaded from the database. */
  history: UIMessage[];
}

export interface PrepareHistoryResult {
  /**
   * Sanitized, compacted, and elided UIMessages — the tail that each route
   * passes to finishModelRequest for conversion.
   */
  messages: UIMessage[];
  /**
   * Non-empty when sliding-window compaction added a synthetic summary.
   * finishModelRequest prepends `{ role: 'user', content: summaryText }` before
   * the converted tail ModelMessages.
   */
  summaryText: string;
  /**
   * Index into the future ModelMessages array where the stable cross-request
   * cache region begins.
   *   1 — when a summary exists (summary is at index 0, first tail msg at 1)
   *   0 — no stable boundary (withCacheBreakpoints skips B when < 1)
   * Feed into withCacheBreakpoints(modelMessages, stableBoundaryIndex).
   */
  stableBoundaryIndex: number;
  /** Schedule compaction via after() — for top-level route handlers. */
  scheduleCompaction: () => void;
  /** Ready-to-use compaction params for tool-execution contexts where after() is unavailable. */
  pendingCompaction: PreparedContext['pendingCompaction'];
}

export interface FinishRequestParams {
  /**
   * Output of prepareHistoryForModel (or any object with the three required fields).
   * The finisher reads summaryText, messages, and stableBoundaryIndex.
   */
  prepared: Pick<PrepareHistoryResult, 'summaryText' | 'messages' | 'stableBoundaryIndex'>;
  /**
   * The exact tool set passed to streamText/generateText — same reference enforces
   * the budget=sent invariant: a divergence between budgeted and sent tools is
   * impossible when both come from the same variable.
   * Required: callers must always thread their tool set through so convertToModelMessages
   * can resolve tool result schemas and the budget=sent invariant is structurally enforced.
   */
  tools: ToolSet;
  /**
   * Pre-processed tail to convert instead of prepared.messages.
   * Use when routes inject visual content or other pre-conversion transforms.
   */
  tail?: Parameters<typeof convertToModelMessages>[0];
}

export interface FinishRequestResult {
  /** Model messages ready for streamText/generateText (summary prepended when present). */
  modelMessages: ModelMessage[];
  /**
   * Same as prepared.stableBoundaryIndex — passed through for per-step
   * withCacheBreakpoints(messages, stableBoundaryIndex) calls in route callbacks.
   */
  stableBoundaryIndex: number;
}

/**
 * Distinct skill names passed to load_skill across a message array (SDK
 * UIMessage dialect: tool parts are `type: 'tool-load_skill'` with the
 * input under `input`). Used to detect skills whose loads were compacted
 * away entirely.
 */
function collectSkillNames(messages: readonly UIMessage[]): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts ?? []) {
      if (part.type !== 'tool-load_skill') continue;
      const input = (part as { input?: { name?: unknown } }).input;
      if (typeof input?.name === 'string') names.add(input.name);
    }
  }
  return [...names];
}

// ─── Seam ──────────────────────────────────────────────────────────────────────

/**
 * Prepare conversation history for model consumption.
 *
 * Composition order (all three steps must remain in this order):
 *  1. sanitizeMessagesForModel  — strips incomplete tool pairs, removes system role
 *  2. prepareConversationContext — sliding-window compaction (admin-gated passthrough for others)
 *  3. elideStaleToolOutputs     — chunk-aligned output elision on the retained tail
 *
 * The stableBoundaryIndex returned here and the elision boundary are designed to
 * coincide: when a compaction summary exists (stableBoundaryIndex=1) the elision
 * boundary is set to 0 (no additional tail elision on top of compaction); when
 * there is no summary the chunk-aligned elision boundary directly controls which
 * old tool outputs become deterministic stubs — stable bytes that survive the
 * prefix cache.
 */
export async function prepareHistoryForModel(
  params: PrepareHistoryParams,
): Promise<PrepareHistoryResult> {
  const { history, ...compactionParams } = params;

  // Step 1: sanitize
  const sanitized = sanitizeMessagesForModel(history);

  // Step 2: compaction (admin-gated; non-admin is a passthrough)
  // UIMessage and CompactionMessage are structurally compatible today; the explicit
  // cast (instead of `as never`) makes future shape drift a TypeScript error here
  // rather than a silent runtime mismatch.
  const { messages: compacted, scheduleCompaction, pendingCompaction } =
    await prepareConversationContext({
      messages: sanitized as CompactionMessage[],
      ...compactionParams,
    });

  // Detect whether compaction prepended a synthetic summary. The sentinel check
  // (no DB id + <conversation_summary> prefix) lives in isSyntheticSummaryMessage
  // so this seam and the v1 route cannot drift apart.
  const hasSummary = compacted.length > 0 && isSyntheticSummaryMessage(compacted[0]);
  let summaryText = hasSummary
    ? (compacted[0].parts?.find((p) => p.type === 'text')?.text ?? '')
    : '';
  const tailUIMessages = (hasSummary ? compacted.slice(1) : compacted) as UIMessage[];

  // Compaction can cut a conversation's most recent load_skill turn: the
  // MRU elision protection below only sees the surviving tail, and the
  // summarizer truncates tool results far below skill-body size, so active
  // skill instructions would silently vanish mid-work. Skill bodies are
  // deterministic re-fetchable reads — so rather than re-attaching tens of
  // kilobytes into the summary, append a deterministic re-load pointer for
  // every skill loaded in the compacted head that no longer appears in the
  // tail. The model re-loads on its next step in that domain.
  if (hasSummary) {
    const tailSkillNames = new Set(collectSkillNames(tailUIMessages));
    const lostSkills = collectSkillNames(sanitized).filter((name) => !tailSkillNames.has(name));
    if (lostSkills.length > 0) {
      summaryText +=
        `\n\n[Skill instructions previously loaded in this conversation are no longer in context: ` +
        lostSkills.map((name) => `"${name}"`).join(', ') +
        `. Call load_skill again for any of them before continuing work in that area.]`;
    }
  }

  // Step 3: elide stale tool outputs from the tail
  //
  // Always compute a chunk-aligned boundary from the tail's assistant turn count,
  // regardless of whether a summary exists. The summary covers the HEAD; the tail
  // still has many turns with large tool outputs that need elision to stay within
  // the context window between compaction fires.
  const assistantTurnCount = tailUIMessages.filter((m) => m.role === 'assistant').length;
  const compactionPointer: number | undefined = undefined;

  const elisionBoundary = computeElisionBoundary(assistantTurnCount, {
    keepLastTurns: ELISION_KEEP_LAST_TURNS,
    chunkSize: ELISION_CHUNK_SIZE,
    compactionPointer,
  });

  const elidedMessages: UIMessage[] =
    elisionBoundary > 0
      ? (elideStaleToolOutputs(tailUIMessages as ElisionMessage[], {
          elisionBoundaryTurnIndex: elisionBoundary,
          minOutputChars: ELISION_MIN_OUTPUT_CHARS,
          elidableTools: new Set(DEFAULT_ELIDABLE_TOOLS),
          writeTools: WRITE_TOOLS,
          // The newest load of each skill is the agent's active instructions —
          // protected from elision (superseded loads of the same skill decay).
          protectMostRecentByArgs: new Set(['load_skill']),
        }) as UIMessage[])
      : tailUIMessages;

  // stableBoundaryIndex: 1 when summary exists (summary is at future ModelMessages[0],
  // first tail message is at [1] — the stable cross-request cache breakpoint B).
  // 0 → withCacheBreakpoints skips B.
  const stableBoundaryIndex = hasSummary ? 1 : 0;

  return {
    messages: elidedMessages,
    summaryText,
    stableBoundaryIndex,
    scheduleCompaction,
    pendingCompaction,
  };
}

// ─── Finisher ──────────────────────────────────────────────────────────────────

/**
 * Convert a prepared history into model-ready messages.
 *
 * Owns the three steps that every entry point must perform after
 * prepareHistoryForModel:
 *   1. Convert UIMessages to ModelMessages via convertToModelMessages
 *   2. Prepend the compaction summary (when present)
 *   3. Pass through stableBoundaryIndex for per-step withCacheBreakpoints
 *
 * The `tools` param enforces the budget=sent invariant: pass the exact same
 * ToolSet reference given to streamText/generateText so divergence is
 * structurally impossible.
 */
export async function finishModelRequest(params: FinishRequestParams): Promise<FinishRequestResult> {
  const { prepared, tools, tail } = params;
  const toConvert = tail ?? (prepared.messages as Parameters<typeof convertToModelMessages>[0]);
  // v6: convertToModelMessages is async.
  const tailModelMessages = await convertToModelMessages(toConvert, { tools });
  const modelMessages: ModelMessage[] = prepared.summaryText
    ? [{ role: 'user' as const, content: prepared.summaryText }, ...tailModelMessages]
    : tailModelMessages;
  return { modelMessages, stableBoundaryIndex: prepared.stableBoundaryIndex };
}
