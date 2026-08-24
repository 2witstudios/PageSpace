/**
 * Bound the context an agent loop spends on its own oversized tool payloads.
 *
 * Everything else that reclaims context — sliding-window compaction and stale
 * tool-output elision — runs once per TURN, inside prepareHistoryForModel. A
 * single turn, though, is up to AGENT_MAX_STEPS (100) model calls, and between
 * those steps nothing reclaims anything: `prepareStep` only re-marked cache
 * breakpoints. So the transcript the provider is handed grows monotonically for
 * the whole turn, and an agent moving large payloads pays for every earlier one
 * on every later step.
 *
 * That is the shape behind #2461. Driving the real loop measures dead-linear
 * growth in BOTH directions — ~+103 KB per step for arguments the model writes,
 * ~+100 KB per step for results it reads — until the window is exhausted and the
 * provider starts emitting tool calls with no argument tokens at all. The
 * reporter's agent did both at once: `readFile` a JSON chunk (large result), then
 * `edit_sheet_cells` it (large arguments). Capping only one direction would have
 * left the bug reproducible for the other.
 *
 * Elision could not have caught this, and adding `execute_tool` to
 * DEFAULT_ELIDABLE_TOOLS would not have either: elision and `capToolResultSize`
 * both run between turns, never between steps.
 *
 * What is capped, and what is deliberately kept:
 *
 * - Tool ARGUMENTS: everything but the newest call. Arguments are content the
 *   model itself just wrote, and the result of the call is still in front of it,
 *   so an older payload is the cheapest thing in the transcript to give up.
 * - Tool RESULTS: everything but the newest few. A result is information the
 *   model READ and may still be consuming — a gather-then-act agent reads two or
 *   three files before it writes anything, and capping those would break it
 *   mid-thought. The number kept is a heuristic; what matters is that retention
 *   is constant in the number of steps rather than growing with it.
 *
 * Capping only ever rewrites the messages SENT for one step. The run's recorded
 * steps keep every payload at full size, so persistence and the activity log see
 * exactly what the agent really sent and received (asserted in the tests).
 */
import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai';

/** Not exported by `ai`, but reachable from the part that carries it. */
type ToolResultOutput = ToolResultPart['output'];

/**
 * Ceiling on a single serialized tool payload, in characters.
 *
 * Deliberately looser than the 8 000-char cap `capToolResultSize` puts on tool
 * outputs between turns. That one trims history the model has already moved past;
 * this one runs while the work is still in flight, when a payload is far more
 * likely to still matter. 24 000 chars (~6 k tokens) sits well above ordinary
 * reads and writes and well below the several-hundred-KB payloads that exhaust a
 * window in four calls. The job is to stop one turn's payloads from ending the
 * turn, not to trim work of ordinary size.
 */
export const TOOL_PAYLOAD_MAX_CHARS = 24_000;

/**
 * How many of the most recent tool results survive at full size.
 *
 * One would be enough for the read-then-write agent in #2461, where each result
 * is consumed by the very next step. A small window also covers the agent that
 * gathers a few things before acting on them. Beyond that the model is working
 * from what it has already concluded, not from the raw bytes.
 */
export const KEEP_RECENT_TOOL_RESULTS = 3;

/** Marker key for a capped payload. Kept greppable in provider logs. */
const ELIDED_KEY = '__payload_elided';

const elided = (what: string, originalChars: number, stillAvailable: string) =>
  `${what} (${originalChars} characters) elided to keep this turn inside the context window. ` +
  `This call already ran; ${stillAvailable}`;

const argumentsStub = (chars: number) =>
  elided('Arguments', chars, 'its result appears in the transcript.');

const resultStub = (chars: number) =>
  elided('Result', chars, 'call it again with the same arguments if you still need it.');

// Narrow to the SDK's own part types, not to a structural stand-in. A predicate
// like `part is { type: string; output?: unknown }` looks equivalent but is not:
// every member of the content union satisfies `{ type: string }`, so TypeScript
// keeps them all and `part.output` fails on TextPart.
const hasType = (part: unknown, type: string): boolean =>
  typeof part === 'object' && part !== null && (part as { type?: unknown }).type === type;

const isToolCallPart = (part: unknown): part is ToolCallPart => hasType(part, 'tool-call');

const isToolResultPart = (part: unknown): part is ToolResultPart => hasType(part, 'tool-result');

/** Serialized size of a value, or null when it has none to measure. */
function sizeOf(value: unknown): number | null {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : serialized.length;
}

/**
 * Replace an argument payload with a stub object.
 *
 * Stays an OBJECT rather than becoming a string: providers model tool arguments
 * as a JSON object, and handing one a bare string on replay is a shape change the
 * call/result pairing does not survive everywhere.
 */
const cappedInput = (chars: number): Record<string, string> => ({
  [ELIDED_KEY]: argumentsStub(chars),
});

/**
 * Replace a result payload with a stub, preserving the output's own `type`.
 *
 * The type is load-bearing — `error-text` tells the provider the tool failed, and
 * rewriting it to `text` would silently turn a failure into a success. So only
 * the value is replaced, in whichever shape that type declares.
 *
 * `execution-denied` carries no value, and `content` is a multimodal array whose
 * bulk is images rather than text; both are left alone.
 */
function cappedOutput(output: ToolResultOutput, maxChars: number): ToolResultOutput | null {
  switch (output.type) {
    case 'text':
    case 'error-text': {
      const chars = sizeOf(output.value);
      if (chars === null || chars <= maxChars) return null;
      return { ...output, value: resultStub(chars) };
    }
    case 'json':
    case 'error-json': {
      const chars = sizeOf(output.value);
      if (chars === null || chars <= maxChars) return null;
      return { ...output, value: { [ELIDED_KEY]: resultStub(chars) } };
    }
    default:
      return null;
  }
}

/** Positions (`messageIndex:partIndex`) of every part matching `predicate`, in order. */
function positionsOf(
  messages: ModelMessage[],
  predicate: (part: unknown) => boolean
): string[] {
  const positions: string[] = [];
  messages.forEach((message, messageIdx) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIdx) => {
      if (predicate(part)) positions.push(`${messageIdx}:${partIdx}`);
    });
  });
  return positions;
}

/**
 * Return a NEW message array in which oversized tool payloads from
 * already-executed steps are replaced by stubs. Pure: never mutates its input,
 * and returns the original array reference when nothing needed capping.
 *
 * Byte stability: the cap is a pure function of the payload, a fixed threshold,
 * and a fixed retention window, so a payload that has been capped once caps
 * identically on every later step. Each oversized payload changes bytes exactly
 * once — when it falls out of the retention window — which is the same
 * forward-only class of change the chunk-aligned elision boundary already makes,
 * and a far cheaper one than losing the turn.
 */
export function capStepToolPayloads(
  messages: ModelMessage[],
  maxChars: number = TOOL_PAYLOAD_MAX_CHARS,
): ModelMessage[] {
  // Exempt the newest call and the newest few results. Positions, not identity:
  // the same part object can legitimately appear more than once in a history
  // assembled from shared parts.
  const callPositions = positionsOf(messages, isToolCallPart);
  const resultPositions = positionsOf(messages, isToolResultPart);
  const exempt = new Set([
    ...callPositions.slice(-1),
    ...resultPositions.slice(-KEEP_RECENT_TOOL_RESULTS),
  ]);

  let didCap = false;

  const result = messages.map((message, messageIdx) => {
    if (!Array.isArray(message.content)) return message;

    let messageChanged = false;
    const content = message.content.map((part, partIdx) => {
      if (exempt.has(`${messageIdx}:${partIdx}`)) return part;

      if (isToolCallPart(part)) {
        if (part.input === undefined) return part;
        const chars = sizeOf(part.input);
        if (chars === null || chars <= maxChars) return part;
        messageChanged = true;
        didCap = true;
        return { ...part, input: cappedInput(chars) };
      }

      if (isToolResultPart(part)) {
        // The size check lives inside cappedOutput, with the switch that knows
        // which shape this output's `value` actually has.
        const capped = cappedOutput(part.output, maxChars);
        if (capped === null) return part;
        messageChanged = true;
        didCap = true;
        return { ...part, output: capped };
      }

      return part;
    });

    return messageChanged ? { ...message, content } : message;
  });

  return didCap ? (result as ModelMessage[]) : messages;
}
