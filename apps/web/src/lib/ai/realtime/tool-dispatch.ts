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
 * RESULTS ARE NOT TRUNCATED, AND THE CAP THAT USED TO DO IT WAS A BUG. Every
 * result was cut to 700 characters here on the reasoning that a spoken answer
 * cannot be skimmed — which is true, and is a fact about what the model SAYS.
 * This is what the model KNOWS, and starving that is what made a call unable to
 * do its job:
 *   - `tool_search` returns JSON Schemas. Sliced at 700 characters it hands back
 *     one schema cut mid-object, so the model cannot build the `execute_tool`
 *     call it went looking for — it guesses parameters, fails, and tries again.
 *   - `read_page` returned the first 700 characters of a document, which is
 *     neither a summary nor enough to edit from: `replace_lines` needs line
 *     numbers off a full read.
 *   - `list_pages` was cut off, so "find my document" failed whenever the
 *     document sorted late.
 * The typed surface caps tool results nowhere, and this is the same agent. Where
 * a result really is too large to want whole, the TOOL says so — `read_page`
 * takes `lineStart`/`lineEnd` — which is a decision the model can make with the
 * page in front of it, and a blanket cap here never could.
 *
 * Brevity is still required; it is just enforced where it belongs. The spoken
 * override in `instructions.ts` asks for two or three sentences a turn, and the
 * model summarises the result rather than reciting it.
 *
 * THERE IS STILL A CEILING, AND IT IS ABOUT THE SESSION, NOT ABOUT SPEECH. A
 * realtime session has 32k tokens, shared with the seed, the instructions and
 * the audio for the whole call, and a `function_call_output` stays in it. One
 * result can therefore end a call outright — measured, not theorised:
 * `tool_search` for a broad keyword returns 21k characters, and for a
 * single-letter query 89k, which is ~22k tokens on its own.
 *
 * The ceiling is set so the path the model is actually TOLD to take survives
 * whole. `TOOL_DISCOVERY_PROMPT` instructs `tool_search("select:name")` to get
 * a schema before calling a tool; two tools that way is ~7k characters, and an
 * ordinary page read is far less. What gets cut is the pathological case — a
 * broad keyword dump the model did not need in full — and it is told how to ask
 * again more narrowly.
 */

import type { Tool, ToolSet } from 'ai';
import type { z } from 'zod';
import type { ToolExecutionContext } from '../core/types';
import type {
  VoiceAssistant,
  VoiceLocationContext,
} from '@pagespace/lib/realtime/voice-bridge-contract';

/**
 * How much of one tool result a call can afford to keep.
 *
 * ~3k tokens. Sized against the 32k session rather than against a listener's
 * patience — the model summarises for the listener, and the prompt is what
 * makes it brief. Above `tool_search("select:…")` (~7k characters for two
 * tools, the schema lookup the discovery prompt instructs) and above an
 * ordinary page read; below the point where a single result crowds out the
 * conversation it belongs to.
 */
export const MAX_RESULT_CHARS = 12_000;

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
 * A tool's return value as the one string `function_call_output.output` accepts.
 *
 * A string result passes through untouched; anything else is serialized, because
 * the model reads JSON perfectly well and inventing prose for an arbitrary shape
 * would mean guessing at a schema this module does not know.
 *
 * `'Done.'` for an empty result is not cosmetic: a tool that returns nothing has
 * still succeeded, and an empty `output` reads to the model as a call that
 * produced no answer.
 */
export const formatToolResult = (value: unknown): string => {
  const text = typeof value === 'string' ? value : safeStringify(value);
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'Done.';
  if (trimmed.length <= MAX_RESULT_CHARS) return trimmed;

  const window = trimmed.slice(0, MAX_RESULT_CHARS);
  const lastSpace = window.lastIndexOf(' ');
  const head = (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
  // The hint is for the MODEL. Without it a cut result reads as a complete one,
  // and the model reports the content ended where the ceiling did. It names the
  // two ways to ask again because they are the two shapes that get cut: a
  // search that matched too much, and a page too long to read at once.
  return `${head}…\n\n[${trimmed.length - head.length} characters were not returned. Ask again more narrowly — tool_search("select:exact_name") for one tool's schema, or read_page with lineStart/lineEnd for the rest of a page.]`;
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

/**
 * What a dispatch produced: the sentence the model gets, and whether the tool
 * actually WORKED.
 *
 * The two are deliberately different questions. Every failure below still
 * yields a speakable `output` — the model is blocked on `function_call_output`
 * and must be unblocked whatever happened — so "the call returned" is not
 * evidence the tool succeeded. Anything recording the call for a human needs
 * the other answer: without it, a permission error is written into the thread
 * as a completed tool call with a sentence about failure inside it, rendered
 * green.
 */
export type RealtimeToolOutcome = {
  readonly output: string;
  readonly failed: boolean;
};

export type RealtimeToolDispatchDeps = {
  /** The set the session advertised — `buildRealtimeToolSet(buildPageSpaceTools())`. */
  readonly tools: ToolSet;
  readonly logger: {
    readonly warn: (message: string, meta?: Record<string, unknown>) => void;
    readonly error: (message: string, error: Error, meta?: Record<string, unknown>) => void;
  };
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
): Promise<RealtimeToolOutcome> => {
  const failure = (output: string): RealtimeToolOutcome => ({ output, failed: true });

  const tool: Tool | undefined = deps.tools[request.name];
  if (!tool) {
    deps.logger.warn('Realtime voice tool call named an unadvertised tool', {
      callId: request.callId,
      userId: request.userId,
      tool: request.name,
    });
    return failure(
      `There is no tool called "${request.name}". Use tool_search to find the right one.`,
    );
  }
  if (!tool.execute) {
    return failure(`The tool "${request.name}" cannot be run.`);
  }

  const parsed = parseToolArguments(request.argumentsJson);
  if (!parsed.ok) {
    deps.logger.warn('Realtime voice tool call had unreadable arguments', {
      callId: request.callId,
      userId: request.userId,
      tool: request.name,
    });
    return failure(parsed.message);
  }

  const validated = (tool.inputSchema as z.ZodType).safeParse(parsed.args);
  if (!validated.success) {
    return failure(
      `Invalid parameters for "${request.name}": ${validated.error.message}. Call tool_search("select:${request.name}") for the correct schema.`,
    );
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
    return { output: formatToolResult(result), failed: false };
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
    return failure(formatToolResult(`That didn't work: ${message}`));
  }
};
