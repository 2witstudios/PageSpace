/**
 * Bound the context an agent loop spends on its OWN oversized tool arguments.
 *
 * Everything else that reclaims context — sliding-window compaction and stale
 * tool-output elision — runs once per TURN, inside prepareHistoryForModel. A
 * single turn, though, is up to AGENT_MAX_STEPS (100) model calls, and between
 * those steps nothing reclaims anything: `prepareStep` only re-marks cache
 * breakpoints. So the transcript the provider is handed grows monotonically for
 * the whole turn, and an agent writing large payloads pays the full size of
 * every earlier payload on every later step.
 *
 * That is the shape behind #2461. Driving the real loop with ~100 KB
 * `execute_tool` payloads measures dead-linear growth — 71 bytes at step 1, then
 * +103 KB per step, every byte of it the model's own arguments — until the
 * window is exhausted and the provider starts emitting tool calls with no
 * argument tokens at all.
 *
 * Elision could never have caught this, and adding `execute_tool` to
 * DEFAULT_ELIDABLE_TOOLS would not have either: elision replaces tool OUTPUTS,
 * and these bytes are INPUTS. Inputs are deliberately left alone there so that
 * the call/result pair survives convertToModelMessages — which is why this
 * capping keeps the part, its id, and its object-ness, and rewrites only the
 * argument value.
 *
 * The counterpart for outputs is capToolResultSize in
 * packages/lib/src/ai/context-window.ts; this is the same idea one layer over.
 */
import type { ModelMessage } from 'ai';

/**
 * Ceiling on a single serialized tool-argument payload, in characters.
 *
 * Deliberately looser than the 8 000-char cap `capToolResultSize` puts on tool
 * OUTPUTS. An output is a refetchable read the model can always ask for again;
 * an argument payload is content the model AUTHORED, and it may still be
 * reasoning about what it just wrote. 24 000 chars (~6 k tokens) sits well above
 * ordinary writes — a long document body, a big page edit — and well below the
 * several-hundred-KB payloads that exhaust a window in four calls. The job here
 * is to stop one turn's authored payloads from ending the turn, not to trim
 * writes of ordinary size.
 */
export const TOOL_INPUT_MAX_CHARS = 24_000;

/** Marker key for a capped argument payload. Kept greppable in provider logs. */
const ELIDED_KEY = '__arguments_elided';

interface ToolCallPartLike {
  type: string;
  input?: unknown;
}

function isToolCallPart(part: unknown): part is ToolCallPartLike {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'tool-call'
  );
}

/**
 * Replace `input` with a stub object.
 *
 * Stays an OBJECT rather than becoming a string: providers model tool arguments
 * as a JSON object, and handing one a bare string on replay is a shape change
 * the call/result pairing does not survive everywhere.
 */
function capInput(originalChars: number): Record<string, string> {
  return {
    [ELIDED_KEY]:
      `Arguments (${originalChars} characters) were elided to keep this turn inside the context window. ` +
      `This call already ran — its result appears in the transcript below.`,
  };
}

/**
 * Return a NEW message array in which oversized tool-call arguments from
 * ALREADY-EXECUTED steps are replaced by a stub. Pure: never mutates its input,
 * and returns the original array reference when nothing needed capping.
 *
 * The most recent tool call is always left intact. It is the step the model just
 * took, so its arguments are the ones most likely to still be load-bearing for
 * the next decision; capping it would save one payload at the moment it costs
 * the most. Every older call keeps only its result, which is what the model
 * actually reasons from.
 *
 * Byte stability: the cap is a pure function of the payload and a fixed
 * threshold, so a message that has been capped once caps identically on every
 * later step. Each oversized call changes bytes exactly once — when it stops
 * being the newest — which is the same forward-only class of change the
 * chunk-aligned elision boundary already makes, and a far cheaper one than
 * losing the turn.
 */
export function capStepToolInputs(
  messages: ModelMessage[],
  maxChars: number = TOOL_INPUT_MAX_CHARS,
): ModelMessage[] {
  // Locate the newest tool call so it can be exempted. Indices, not identity:
  // the same part object can legitimately appear more than once in a history
  // assembled from shared parts.
  let newestMessageIdx = -1;
  let newestPartIdx = -1;
  messages.forEach((message, messageIdx) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIdx) => {
      if (!isToolCallPart(part)) return;
      newestMessageIdx = messageIdx;
      newestPartIdx = partIdx;
    });
  });

  let didCap = false;

  const result = messages.map((message, messageIdx) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;

    let messageChanged = false;
    const content = message.content.map((part, partIdx) => {
      if (!isToolCallPart(part)) return part;
      if (messageIdx === newestMessageIdx && partIdx === newestPartIdx) return part;
      if (part.input === undefined) return part;

      // JSON.stringify can return undefined (a function or a bare `undefined`
      // as the whole value); nothing to measure or cap in that case.
      const serialized = JSON.stringify(part.input);
      if (serialized === undefined || serialized.length <= maxChars) return part;

      messageChanged = true;
      didCap = true;
      return { ...part, input: capInput(serialized.length) };
    });

    return messageChanged ? { ...message, content } : message;
  });

  return didCap ? (result as ModelMessage[]) : messages;
}
