/**
 * A tool call a voice turn made, written into the thread the way a typed one is.
 *
 * WHY THIS EXISTS. A call used to leave no trace of its work: only what was
 * SAID was persisted, so the thread showed an assistant announcing an answer
 * with nothing between the question and it, and a reload showed the same. The
 * typed surface has recorded tool calls all along — same columns, same parts,
 * same renderer — and voice simply never sent them.
 *
 * Nothing here is new machinery. The part shape is the one `chunkToPart`
 * produces, the payload is built by the same `buildAssistantPersistencePayload`
 * the typed path uses, and delivery is the socket event a voice write already
 * triggers. This module only decides what a tool call looks like as a message.
 *
 * TWO WRITES, ONE ROW. `started` creates it in `input-available` — a spinner —
 * and `finished` names the same `messageId` so the repository UPDATES it into
 * `output-available` (or `output-error`). That is why the row converges instead
 * of the thread filling with pairs: `appendPart` replaces a tool part by its
 * `toolCallId`, and `emitAfterSave` emits `messageUpdated` for a row that
 * existed.
 *
 * IT IS NEVER ON THE MODEL'S PATH. The tool's answer goes back over the socket
 * from `voice-call-runtime.ts`; this is a record written alongside. A failure
 * here costs the row, never the turn.
 */

import type { UIMessage } from 'ai';
import { buildAssistantPersistencePayload } from '../core/persistAssistantParts';
import type { UIMessagePart } from '../core/stream-multicast-registry';
import {
  persistVoiceTranscript,
  type TranscriptPersistenceDeps,
  type TranscriptWriteResult,
} from './transcript-persistence';

export type ToolActivityRequest = {
  readonly callId: string;
  readonly userId: string;
  readonly conversationId: string;
  /** OpenAI's `function_call.call_id`, which both phases agree on. */
  readonly toolCallId: string;
  readonly name: string;
  readonly argumentsJson: string;
  /** Absent while running; present to update that row into its result. */
  readonly messageId?: string;
  readonly output?: string;
  readonly errorText?: string;
};

/**
 * Arguments as the thread should show them.
 *
 * Parsed rather than passed through as a string so the renderer receives the
 * same `input` shape a typed tool call has — its cards read fields off an
 * object. A payload that will not parse still shows the call: the raw string is
 * more useful on screen than an empty card, and this is a record, not a
 * dispatch. The copy that has to be right is parsed in `tool-dispatch.ts`.
 */
const inputFor = (argumentsJson: string): unknown => {
  const trimmed = argumentsJson.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
};

/**
 * The tool part, in the exact shape `chunkToPart` emits for the typed surface.
 *
 * Matching it is the whole trick: every renderer, every merge rule and the
 * reload path are all keyed to this shape, so a voice tool call gets all of
 * them for free.
 */
const toolPart = (request: ToolActivityRequest, input: unknown): UIMessagePart => {
  const base = {
    type: `tool-${request.name}`,
    toolCallId: request.toolCallId,
    toolName: request.name,
    input,
  };

  if (request.errorText !== undefined) {
    return { ...base, state: 'output-error', errorText: request.errorText } as UIMessagePart;
  }
  if (request.output !== undefined) {
    return { ...base, state: 'output-available', output: request.output } as UIMessagePart;
  }
  return { ...base, state: 'input-available' } as UIMessagePart;
};

/**
 * Write (or update) the row for one tool call.
 *
 * The conversation resolution, the access check and the global-versus-page
 * attribution are `persistVoiceTranscript`'s, deliberately: those decisions are
 * security-relevant and there must not be a second copy of them that a spoken
 * tool call takes instead.
 *
 * THE ROW HAS NO TEXT, and that is load-bearing rather than an omission.
 * Nothing was SAID here — the model spoke separately, and that turn is its own
 * transcript row. Two things depend on this being empty:
 *   - `buildRealtimeSeed` replays a message's `content` as an utterance, so a
 *     label here would seed the NEXT call with "Read Page: Roadmap" as though
 *     the assistant had said it, and spend the seed's turn budget on things
 *     nobody said;
 *   - `MessageRenderer` builds its text from PARTS, so a tool row already
 *     renders correctly with none — it is the tool card, not a sentence.
 * It is also simply what `buildAssistantPersistencePayload` computes for a
 * parts array holding one tool part.
 */
export const persistVoiceToolActivity = async (
  deps: TranscriptPersistenceDeps,
  request: ToolActivityRequest,
): Promise<TranscriptWriteResult> => {
  const messageId = request.messageId ?? deps.newMessageId();
  const input = inputFor(request.argumentsJson);
  const part = toolPart(request, input);
  const payload = buildAssistantPersistencePayload(messageId, [part]);

  return persistVoiceTranscript(
    deps,
    {
      callId: request.callId,
      userId: request.userId,
      conversationId: request.conversationId,
      role: 'assistant',
      text: payload.content,
    },
    {
      messageId,
      uiMessage: payload.uiMessage as UIMessage,
      ...(payload.toolCalls === undefined ? {} : { toolCalls: payload.toolCalls }),
      ...(payload.toolResults === undefined ? {} : { toolResults: payload.toolResults }),
    },
  );
};
