/**
 * Realtime data-channel events, parsed purely.
 *
 * Shapes verified against the OpenAI Realtime docs: the model announces tool
 * calls as `function_call` items inside `response.done`, and the client answers
 * with a `conversation.item.create` carrying a `function_call_output`, then
 * `response.create`.
 *
 * Assistant transcripts are read from the streaming transcript-done event under
 * BOTH names — `response.output_audio_transcript.done` (current) and
 * `response.audio_transcript.done` (earlier) — because the event was renamed
 * across releases and some deployments still emit the old name.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

export type FunctionCall = {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
};

export type TranscriptEntry = {
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const outputItems = (event: Record<string, unknown>): unknown[] => {
  const response = asRecord(event.response);
  const output = response?.output;
  return Array.isArray(output) ? output : [];
};

/** Tool calls the model wants run. Empty for every other event. */
export const extractFunctionCalls = (event: unknown): FunctionCall[] => {
  const record = asRecord(event);
  if (!record || record.type !== 'response.done') {
    return [];
  }
  const calls: FunctionCall[] = [];
  for (const raw of outputItems(record)) {
    const item = asRecord(raw);
    if (!item || item.type !== 'function_call') {
      continue;
    }
    const callId = asString(item.call_id);
    const name = asString(item.name);
    if (!callId || !name) {
      continue;
    }
    calls.push({
      callId,
      name,
      // Absent arguments mean a no-argument tool, not a malformed call.
      argumentsJson: asString(item.arguments) ?? '{}',
    });
  }
  return calls;
};

const USER_TRANSCRIPT_TYPE =
  'conversation.item.input_audio_transcription.completed';

/**
 * Both names are required: `response.audio_transcript.done` was renamed to
 * `response.output_audio_transcript.done`, and deployments straddle the change.
 */
const ASSISTANT_TRANSCRIPT_TYPES = new Set([
  'response.output_audio_transcript.done',
  'response.audio_transcript.done',
]);

/** What was said, for the on-screen record. */
export const extractTranscript = (
  event: unknown,
): TranscriptEntry | undefined => {
  const record = asRecord(event);
  const type = asString(record?.type);
  if (!record || !type) {
    return undefined;
  }

  if (type === USER_TRANSCRIPT_TYPE) {
    const text = asString(record.transcript);
    return text ? { role: 'user', text } : undefined;
  }

  if (ASSISTANT_TRANSCRIPT_TYPES.has(type)) {
    const text = asString(record.transcript);
    return text ? { role: 'assistant', text } : undefined;
  }

  return undefined;
};

/** The client event that hands a tool's result back to the model. */
export const buildFunctionOutput = (
  callId: string,
  output: string,
): Record<string, unknown> => ({
  type: 'conversation.item.create',
  item: {
    type: 'function_call_output',
    call_id: callId,
    output,
  },
});

/** Told to speak after tool output lands. */
export const RESPONSE_CREATE = { type: 'response.create' } as const;

/** Data channel frames arrive as strings; a malformed one must not throw. */
export const parseEvent = (data: unknown): unknown => {
  if (typeof data !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};
