/**
 * Running the tool the model asked for, out loud.
 *
 * The realtime server hears `function_call` on the socket and posts here; this
 * module turns that into a real PageSpace tool invocation and a string the
 * model can speak. It is the only place in the voice plane where a tool runs,
 * and it runs them through the SAME registry, the SAME `ToolExecutionContext`
 * and therefore the SAME permission checks the text stack uses.
 *
 * PERMISSIONS ARE NOT RE-IMPLEMENTED HERE, and that is the design, not an
 * omission. Every PageSpace tool enforces access INSIDE itself — `canActorViewPage`,
 * `canActorAccessDrive`, `resolveActorAccessiblePagesInDrive` — against the
 * ACTOR on the context it is handed. So the single security-relevant thing
 * this module does is build that context from the REAL actor and pass it
 * unchanged. A second permission layer here would be a second thing to keep in
 * step with `packages/lib/src/permissions/`, and the first time they disagreed,
 * one of them would be wrong.
 *
 * "The real actor" is the invoking user OR the page agent the call is bound to
 * — the same choice `page-chat-turn.ts` makes for the same conversation. It is
 * resolved once, server-side, from the authorized conversation at handshake
 * time; nothing the browser or the model says selects it. See
 * `buildVoiceToolContext`.
 *
 * Two shapes on the wire are load-bearing and are handled defensively:
 *   - `function_call.arguments` is a newline-laden STRING, not an object, and
 *     is not guaranteed to parse;
 *   - `function_call_output.output` must be a STRING — so everything below
 *     returns one, including every failure.
 *
 * WHY RESULTS ARE TRUNCATED. A spoken answer cannot be skimmed. A full page
 * read is a two-minute monologue that the user cannot scan, interrupt usefully,
 * or remember — and in a live turn latency wins, with completeness happening in
 * the thread afterwards. The reference prototype
 * (`~/production/pagespace-voice/src/core/present.ts`) solves this with a
 * hand-written presenter per tool; that does not scale to PageSpace's registry
 * of dozens, and a curated presenter list would be a second tool surface that
 * drifts every time a tool is added. So the cap is generic and structural: cut
 * at a word boundary, say how much was left out, and tell the model how to get
 * the rest — the same contract `truncateForSpeech` offers, applied uniformly.
 */

import type { Tool, ToolSet } from 'ai';
import type { z } from 'zod';
import type { ToolExecutionContext } from '../core/types';
import type {
  VoiceAssistant,
  VoiceLocationContext,
} from '@pagespace/lib/realtime/voice-bridge-contract';

/**
 * How much of a tool result is worth reading aloud. 700 characters is roughly
 * 45 seconds of speech — already long for a spoken answer, and past the point
 * where a listener retains the beginning.
 */
export const MAX_SPOKEN_RESULT_CHARS = 700;

/** Parsed arguments, or the sentence to say instead. */
type ParsedArguments =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * Parse `function_call.arguments`.
 *
 * Absent or blank means a no-argument tool, not a malformed call — the model
 * omits the field entirely for tools that take nothing.
 *
 * The recovery pass matters more than it looks: the string is assembled from
 * streamed deltas, so a truncated or double-appended payload is a real (if
 * rare) outcome, and it arrives as plain text with embedded newlines rather
 * than as anything JSON-shaped. Taking the first balanced object turns the
 * common corruption — trailing junk after a complete object — into a working
 * call instead of an apology. Anything else becomes a sentence the model can
 * say, because the one thing that must not happen is a tool call with no
 * answer: the model waits for `function_call_output` and the call goes silent.
 */
export const parseToolArguments = (argumentsJson: string): ParsedArguments => {
  const trimmed = argumentsJson.trim();
  if (trimmed.length === 0) return { ok: true, args: {} };

  const asObject = (value: unknown): ParsedArguments =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ok: true, args: value as Record<string, unknown> }
      : {
          ok: false,
          message: 'The arguments for that tool were not an object. Try the call again.',
        };

  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    const recovered = firstBalancedObject(trimmed);
    if (recovered === undefined) {
      return {
        ok: false,
        message: 'The arguments for that tool could not be read. Try the call again.',
      };
    }
    try {
      return asObject(JSON.parse(recovered));
    } catch {
      return {
        ok: false,
        message: 'The arguments for that tool could not be read. Try the call again.',
      };
    }
  }
};

/**
 * The first `{…}` whose braces balance, ignoring braces inside strings. Written
 * out rather than regexed because a regex cannot count nesting, and the payloads
 * that need recovering are exactly the nested ones.
 */
const firstBalancedObject = (text: string): string | undefined => {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
};

/**
 * A tool's return value as one speakable string, capped.
 *
 * A string result is spoken as-is; anything else is serialized, because the
 * model reads JSON perfectly well and inventing prose for an arbitrary shape
 * would mean guessing at a schema this module does not know.
 */
export const formatToolResult = (
  value: unknown,
  maxChars: number = MAX_SPOKEN_RESULT_CHARS,
): string => {
  const text = typeof value === 'string' ? value : safeStringify(value);
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'Done.';
  if (trimmed.length <= maxChars) return trimmed;

  const window = trimmed.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(' ');
  const head = (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
  const omitted = trimmed.length - head.length;
  // The continuation hint is for the MODEL, not the user: it is what turns a
  // cut-off result into "I can read you the rest if you want" instead of the
  // model asserting the content ended there.
  return `${head}… (${omitted} more characters were not read out; call the tool again for a specific part if the user asks for more.)`;
};

/**
 * `JSON.stringify` returns `undefined` for a function/symbol and THROWS on a
 * circular structure or a bigint. A tool result is not ours, so neither
 * outcome may reach the socket as a non-string.
 */
const safeStringify = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export type RealtimeToolDispatchRequest = {
  readonly name: string;
  readonly argumentsJson: string;
  readonly userId: string;
  readonly conversationId?: string;
  readonly timezone?: string;
  readonly locationContext?: VoiceLocationContext;
  readonly callId: string;
  /**
   * The page agent this call is bound to, resolved server-side from the
   * authorized conversation at handshake time. Absent for the Global Assistant
   * and for an unbound call, which act as the user.
   */
  readonly assistant?: VoiceAssistant;
};

export type RealtimeToolDispatchDeps = {
  /** The set the session advertised — `buildRealtimeToolSet(buildPageSpaceTools())`. */
  readonly tools: ToolSet;
  readonly logger: {
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
    readonly error: (message: string, error: Error, meta?: Record<string, unknown>) => void;
  };
  readonly maxChars?: number;
};

/**
 * The `ToolExecutionContext` a voice turn runs under.
 *
 * `requestOrigin: 'user'` and `agentCallDepth: 0` because a spoken turn is a
 * person talking, not an agent calling an agent — the fields that gate
 * agent-chain behaviour have to say so or a voice call would be attributed as
 * a sub-agent run.
 *
 * WHO THE TOOLS RUN AS. `chatSource` is what `resolveActingAgentId` reads, and
 * every centralized `canActor*` check falls through to the INVOKING USER's own
 * reach without it. For a call bound to a page agent that is the wrong actor in
 * both directions: an agent whose memberships are narrower than the caller's
 * would silently borrow the caller's, and the text surface
 * (`page-chat-turn.ts`) authorizes as the agent for the same conversation. So a
 * bound agent is named here, exactly as the text path names it.
 *
 * `enabledTools` is carried for the same reason, not as a second exposure
 * decision. `execute_tool` re-checks the allowlist off THIS field and reads
 * `undefined` as unrestricted, so omitting it on a call bound to a restricted
 * agent re-opens through `execute_tool` precisely the tools its owner switched
 * off. `null` — an agent with no allowlist — is the honest "unrestricted", and
 * is passed through as null rather than dropped.
 */
export const buildVoiceToolContext = (
  request: RealtimeToolDispatchRequest,
  model: string,
): ToolExecutionContext => ({
  userId: request.userId,
  ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
  ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
  ...(request.locationContext === undefined
    ? {}
    : { locationContext: request.locationContext }),
  ...(request.assistant === undefined
    ? {}
    : {
        chatSource: {
          type: 'page' as const,
          agentPageId: request.assistant.agentPageId,
          agentTitle: request.assistant.agentTitle,
        },
        enabledTools: request.assistant.enabledTools,
      }),
  aiProvider: 'openai_voice',
  aiModel: model,
  requestOrigin: 'user',
  agentCallDepth: 0,
});

/**
 * Parse, validate, execute, format. Always resolves to a string, never throws:
 * the caller's next move is `function_call_output`, and there is no version of
 * this that may leave the model without one.
 *
 * Validation mirrors `createExecuteTool` — the tool's own zod `inputSchema`,
 * `safeParse`, and an error message that tells the model how to recover rather
 * than just that it failed.
 */
export const dispatchRealtimeToolCall = async (
  deps: RealtimeToolDispatchDeps,
  request: RealtimeToolDispatchRequest,
  model: string,
): Promise<string> => {
  const tool: Tool | undefined = deps.tools[request.name];
  if (!tool) {
    deps.logger.warn('Realtime voice tool call named an unadvertised tool', {
      callId: request.callId,
      userId: request.userId,
      tool: request.name,
    });
    return `There is no tool called "${request.name}". Use tool_search to find the right one.`;
  }
  if (!tool.execute) {
    return `The tool "${request.name}" cannot be run.`;
  }

  const parsed = parseToolArguments(request.argumentsJson);
  if (!parsed.ok) {
    deps.logger.warn('Realtime voice tool call had unreadable arguments', {
      callId: request.callId,
      userId: request.userId,
      tool: request.name,
    });
    return parsed.message;
  }

  const validated = (tool.inputSchema as z.ZodType).safeParse(parsed.args);
  if (!validated.success) {
    return `Invalid parameters for "${request.name}": ${validated.error.message}. Call tool_search("select:${request.name}") for the correct schema.`;
  }

  const context = buildVoiceToolContext(request, model);

  try {
    const result = await (tool.execute as (args: unknown, options: unknown) => unknown)(
      validated.data,
      // The AI SDK's options bag, as the tools read it. `experimental_context`
      // is the only member any PageSpace tool actually destructures; the other
      // two are present because the SDK's own signature carries them and a tool
      // that grows a use for them should not break on voice.
      { experimental_context: context, toolCallId: request.callId, messages: [] },
    );
    return formatToolResult(result, deps.maxChars);
  } catch (error) {
    // A throwing tool is a normal outcome (permission denied, missing page),
    // and the model has to be able to say something about it. The message is
    // reported because it is written for a user; the stack is not.
    deps.logger.error(
      'Realtime voice tool execution failed',
      error instanceof Error ? error : new Error(String(error)),
      { callId: request.callId, userId: request.userId, tool: request.name },
    );
    const message = error instanceof Error ? error.message : String(error);
    return formatToolResult(`That didn't work: ${message}`, deps.maxChars);
  }
};
