import { parsePartialJson, type UIMessage, type UIMessageChunk } from 'ai';

type AnyPart = UIMessage['parts'][number];

/**
 * Reduce a raw `UIMessageChunk` frame log into the `UIMessagePart[]` the AI SDK
 * itself would have produced from the same frames.
 *
 * WHY THIS EXISTS, AND WHY IT MUST NOT BE "SIMPLIFIED".
 *
 * Before this module the server re-derived a SECOND, lossy copy of the stream via
 * `onChunk` + `chunkToPart` (deleted with this change). That projection forwarded four
 * chunk types — text-delta, tool-call, tool-result, tool-error — and dropped reasoning,
 * files, sources, step boundaries, tool-input streaming, and every `data-*` part the
 * route writes straight to the writer. Its own comment called it "minimal v1 scope;
 * later waves can extend without a wire change". No later wave extended it.
 *
 * The result was two channels carrying different data for one stream: the HTTP response
 * body (full fidelity, exactly one reader) and the multicast/checkpoint channel (the
 * projection, many readers). Everything that reads the durable channel — a rejoining
 * tab, a second browser, the crash materializer, and the execute-end persist that is the
 * SOLE record of a reply whose onFinish never fired — got the reduced copy. Roughly a
 * year of client-side machinery exists only to reconcile the two.
 *
 * So: one channel, and one reduction, and that reduction is the SDK's own. This function
 * mirrors `processUIMessageStream` (ai@6 `dist/index.mjs`) case for case, in order.
 *
 * HOW IT IS KEPT HONEST. `foldChunksToParts.test.ts` runs recorded frame logs through
 * BOTH this function and the SDK's exported `readUIMessageStream`, and asserts deep
 * equality of the resulting parts. That test is the whole point: it fails loudly on any
 * SDK upgrade that changes the reduction, which is the exact class of silent drift that
 * produced the projection this replaces. Do not weaken it to make an upgrade pass — fix
 * the fold, or delete the case from the fold deliberately and say so here.
 *
 * WHY NOT JUST CALL `readUIMessageStream` IN PRODUCTION. It `structuredClone`s the whole
 * accumulated message on every chunk, so folding an N-chunk log is O(N²) in message size.
 * At checkpoint cadence on a long agent reply that is not viable. It is perfect for the
 * test, where correctness is the only axis that matters.
 *
 * ASYNC, deliberately. `tool-input-delta` needs `parsePartialJson` (async in the SDK) to
 * reconstruct a partially-streamed tool input. Handling those frames is the difference
 * between "the fold is the SDK's reduction" and "the fold is a projection with an
 * exception" — and an exception is how the last one started. Every caller is already in
 * an async context.
 *
 * PURE at the boundary: input frames are never read after their values are copied out,
 * and never mutated. The parts array and every part object in it are freshly allocated
 * here, so the in-place mutation below (which mirrors the SDK's own `state.message.parts`
 * mutation) is not observable to a caller.
 */

/** A text or reasoning part being accumulated by id, as the SDK tracks them. */
type StreamingTextPart = {
  type: 'text' | 'reasoning';
  text: string;
  state: 'streaming' | 'done';
  providerMetadata?: unknown;
};

interface PartialToolCall {
  text: string;
  toolName: string;
  dynamic?: boolean;
  title?: string;
  toolMetadata?: unknown;
}

interface UpdateToolPartOptions {
  toolCallId: string;
  toolName: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  rawInput?: unknown;
  errorText?: string;
  providerExecuted?: boolean;
  preliminary?: boolean;
  providerMetadata?: unknown;
  title?: string;
  toolMetadata?: unknown;
  dynamic?: boolean;
}

const isStaticToolPart = (part: AnyPart): boolean => part.type.startsWith('tool-');
const isDynamicToolPart = (part: AnyPart): boolean => part.type === 'dynamic-tool';
const isToolPart = (part: AnyPart): boolean => isStaticToolPart(part) || isDynamicToolPart(part);
/**
 * `tool-my_tool` → `my_tool`. Rejoins on '-' so tool names containing hyphens survive.
 *
 * NOT COVERED BY THE DIFFERENTIAL TEST, and knowingly so — its result is currently never
 * observable. It only feeds `updateToolPart`'s `toolName`, which a STATIC part reads only
 * on the push branch (`type: tool-${toolName}`); and the two callers below
 * (`tool-output-available` / `tool-output-error`) already bailed unless the part exists,
 * so they always take the update branch, where the type is left alone and the lookup is
 * by `toolCallId`. Kept as a faithful mirror of the SDK's `getStaticToolName`, which is
 * dead in exactly the same way, so the two cannot drift if a future version starts
 * routing a result frame through the push branch.
 */
const staticToolName = (part: AnyPart): string => part.type.split('-').slice(1).join('-');

type MutablePart = Record<string, unknown> & { type: string };

export const foldChunksToParts = async (
  frames: readonly UIMessageChunk[],
): Promise<AnyPart[]> => {
  const parts: MutablePart[] = [];
  // Keyed by chunk id, exactly like the SDK's `state.activeTextParts` /
  // `activeReasoningParts`. Null-prototype so a part id of `__proto__` or
  // `constructor` cannot collide with an inherited property — the SDK uses
  // `Object.create(null)` here for the same reason.
  let activeTextParts: Record<string, StreamingTextPart> = Object.create(null);
  let activeReasoningParts: Record<string, StreamingTextPart> = Object.create(null);
  const partialToolCalls: Record<string, PartialToolCall> = Object.create(null);

  /**
   * The SDK's `updateToolPart` / `updateDynamicToolPart`, merged. They differ only in how
   * the part is located (by `type === 'dynamic-tool'` vs `type === 'tool-<name>'`) and in
   * whether `toolName` lives on the part; every field assignment below is identical, so
   * one function with a `dynamic` flag mirrors both without duplicating the assignment
   * list — which is the part that must not drift.
   */
  const updateToolPart = (options: UpdateToolPartOptions): void => {
    const dynamic = options.dynamic === true;
    const existing = parts.find((part) =>
      dynamic
        ? part.type === 'dynamic-tool' && part.toolCallId === options.toolCallId
        : isStaticToolPart(part as AnyPart) && part.toolCallId === options.toolCallId,
    );

    const isResultState =
      options.state === 'output-available' || options.state === 'output-error';

    if (existing) {
      existing.state = options.state;
      if (dynamic) existing.toolName = options.toolName;
      existing.input = options.input;
      existing.output = options.output;
      existing.errorText = options.errorText;
      // Dynamic parts preserve a prior rawInput when the update carries none; static
      // parts overwrite unconditionally. Mirrors the SDK's two implementations exactly.
      //
      // NOT COVERED BY THE DIFFERENTIAL TEST, and knowingly so: in ai@6.0.212 no dynamic
      // code path ever passes rawInput (tool-input-error and tool-output-error both send
      // `input` for dynamic parts, and the input-start/delta/available paths send none),
      // so the `??` is unreachable and a mutation of it is equivalent. It is kept as a
      // faithful mirror rather than simplified away, so that if a future SDK version does
      // start feeding rawInput down the dynamic path we already match. Recorded here
      // because an untested line should say it is untested.
      existing.rawInput = dynamic ? (options.rawInput ?? existing.rawInput) : options.rawInput;
      existing.preliminary = options.preliminary;
      if (options.title !== undefined) existing.title = options.title;
      if (options.toolMetadata !== undefined) existing.toolMetadata = options.toolMetadata;
      existing.providerExecuted = options.providerExecuted ?? existing.providerExecuted;
      if (options.providerMetadata != null) {
        if (isResultState) existing.resultProviderMetadata = options.providerMetadata;
        else existing.callProviderMetadata = options.providerMetadata;
      }
      return;
    }

    parts.push({
      ...(dynamic
        ? { type: 'dynamic-tool', toolName: options.toolName }
        : { type: `tool-${options.toolName}` }),
      toolCallId: options.toolCallId,
      state: options.state,
      title: options.title,
      ...(options.toolMetadata !== undefined ? { toolMetadata: options.toolMetadata } : {}),
      input: options.input,
      output: options.output,
      ...(dynamic ? {} : { rawInput: options.rawInput }),
      errorText: options.errorText,
      providerExecuted: options.providerExecuted,
      preliminary: options.preliminary,
      ...(options.providerMetadata != null && isResultState
        ? { resultProviderMetadata: options.providerMetadata }
        : {}),
      ...(options.providerMetadata != null && !isResultState
        ? { callProviderMetadata: options.providerMetadata }
        : {}),
    });
  };

  /**
   * The SDK's `getToolInvocation`, which THROWS when a result frame names a tool call it
   * never saw start. Here it returns undefined and the caller skips the frame instead.
   *
   * That divergence is deliberate and is the one place this fold is not the SDK. The SDK
   * is reducing a live stream it produced itself, so a missing invocation is a real
   * protocol violation worth failing on. We are reducing a PERSISTED frame log, which can
   * legitimately begin mid-stream: the in-memory ring evicts its oldest frames on a long
   * run, and a rejoining client folds from a cursor. Throwing there would turn "the
   * beginning of a long reply aged out" into "this message cannot be rendered at all".
   * Skipping loses exactly the orphaned frame.
   */
  const findToolInvocation = (toolCallId: string): MutablePart | undefined =>
    parts.find((part) => isToolPart(part as AnyPart) && part.toolCallId === toolCallId);

  for (const frame of frames) {
    switch (frame.type) {
      case 'text-start': {
        const part: StreamingTextPart = {
          type: 'text',
          text: '',
          providerMetadata: frame.providerMetadata,
          state: 'streaming',
        };
        activeTextParts[frame.id] = part;
        parts.push(part as unknown as MutablePart);
        break;
      }
      case 'text-delta': {
        const part = activeTextParts[frame.id];
        if (!part) break; // orphaned frame — see findToolInvocation's note
        part.text += frame.delta;
        part.providerMetadata = frame.providerMetadata ?? part.providerMetadata;
        break;
      }
      case 'text-end': {
        const part = activeTextParts[frame.id];
        if (!part) break;
        part.state = 'done';
        part.providerMetadata = frame.providerMetadata ?? part.providerMetadata;
        delete activeTextParts[frame.id];
        break;
      }

      case 'reasoning-start': {
        const part: StreamingTextPart = {
          type: 'reasoning',
          text: '',
          providerMetadata: frame.providerMetadata,
          state: 'streaming',
        };
        activeReasoningParts[frame.id] = part;
        parts.push(part as unknown as MutablePart);
        break;
      }
      case 'reasoning-delta': {
        const part = activeReasoningParts[frame.id];
        if (!part) break;
        part.text += frame.delta;
        part.providerMetadata = frame.providerMetadata ?? part.providerMetadata;
        break;
      }
      case 'reasoning-end': {
        const part = activeReasoningParts[frame.id];
        if (!part) break;
        part.providerMetadata = frame.providerMetadata ?? part.providerMetadata;
        part.state = 'done';
        delete activeReasoningParts[frame.id];
        break;
      }

      case 'file': {
        parts.push({
          type: 'file',
          mediaType: frame.mediaType,
          url: frame.url,
          ...(frame.providerMetadata != null ? { providerMetadata: frame.providerMetadata } : {}),
        });
        break;
      }
      case 'source-url': {
        parts.push({
          type: 'source-url',
          sourceId: frame.sourceId,
          url: frame.url,
          title: frame.title,
          providerMetadata: frame.providerMetadata,
        });
        break;
      }
      case 'source-document': {
        parts.push({
          type: 'source-document',
          sourceId: frame.sourceId,
          mediaType: frame.mediaType,
          title: frame.title,
          filename: frame.filename,
          providerMetadata: frame.providerMetadata,
        });
        break;
      }

      case 'tool-input-start': {
        partialToolCalls[frame.toolCallId] = {
          text: '',
          toolName: frame.toolName,
          dynamic: frame.dynamic,
          title: frame.title,
          toolMetadata: frame.toolMetadata,
        };
        updateToolPart({
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          state: 'input-streaming',
          input: undefined,
          providerExecuted: frame.providerExecuted,
          title: frame.title,
          toolMetadata: frame.toolMetadata,
          providerMetadata: frame.providerMetadata,
          dynamic: frame.dynamic,
        });
        break;
      }
      case 'tool-input-delta': {
        const partial = partialToolCalls[frame.toolCallId];
        if (!partial) break;
        partial.text += frame.inputTextDelta;
        const { value: partialInput } = await parsePartialJson(partial.text);
        updateToolPart({
          toolCallId: frame.toolCallId,
          toolName: partial.toolName,
          state: 'input-streaming',
          input: partialInput,
          title: partial.title,
          toolMetadata: partial.toolMetadata,
          dynamic: partial.dynamic,
        });
        break;
      }
      case 'tool-input-available': {
        updateToolPart({
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          state: 'input-available',
          input: frame.input,
          providerExecuted: frame.providerExecuted,
          providerMetadata: frame.providerMetadata,
          title: frame.title,
          toolMetadata: frame.toolMetadata,
          dynamic: frame.dynamic,
        });
        break;
      }
      case 'tool-input-error': {
        // The SDK decides dynamic-ness from the EXISTING part when there is one, falling
        // back to the frame's own flag. Keep that order: a part already materialized as
        // static must not be duplicated as dynamic by a frame that disagrees.
        const existing = findToolInvocation(frame.toolCallId);
        const dynamic = existing ? existing.type === 'dynamic-tool' : Boolean(frame.dynamic);
        updateToolPart({
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          state: 'output-error',
          input: dynamic ? frame.input : undefined,
          ...(dynamic ? {} : { rawInput: frame.input }),
          errorText: frame.errorText,
          providerExecuted: frame.providerExecuted,
          providerMetadata: frame.providerMetadata,
          toolMetadata: frame.toolMetadata,
          dynamic,
        });
        break;
      }
      case 'tool-approval-request': {
        const invocation = findToolInvocation(frame.toolCallId);
        if (!invocation) break;
        invocation.state = 'approval-requested';
        invocation.approval = {
          id: frame.approvalId,
          ...(frame.signature != null ? { signature: frame.signature } : {}),
        };
        break;
      }
      case 'tool-output-denied': {
        const invocation = findToolInvocation(frame.toolCallId);
        if (!invocation) break;
        invocation.state = 'output-denied';
        break;
      }
      case 'tool-output-available': {
        const invocation = findToolInvocation(frame.toolCallId);
        if (!invocation) break;
        const dynamic = invocation.type === 'dynamic-tool';
        updateToolPart({
          toolCallId: frame.toolCallId,
          toolName: dynamic
            ? (invocation.toolName as string)
            : staticToolName(invocation as AnyPart),
          state: 'output-available',
          input: invocation.input,
          output: frame.output,
          preliminary: frame.preliminary,
          providerExecuted: frame.providerExecuted,
          providerMetadata: frame.providerMetadata,
          title: invocation.title as string | undefined,
          toolMetadata: invocation.toolMetadata,
          dynamic,
        });
        break;
      }
      case 'tool-output-error': {
        const invocation = findToolInvocation(frame.toolCallId);
        if (!invocation) break;
        const dynamic = invocation.type === 'dynamic-tool';
        updateToolPart({
          toolCallId: frame.toolCallId,
          toolName: dynamic
            ? (invocation.toolName as string)
            : staticToolName(invocation as AnyPart),
          state: 'output-error',
          input: invocation.input,
          ...(dynamic ? {} : { rawInput: invocation.rawInput }),
          errorText: frame.errorText,
          providerExecuted: frame.providerExecuted,
          providerMetadata: frame.providerMetadata,
          title: invocation.title as string | undefined,
          toolMetadata: invocation.toolMetadata,
          dynamic,
        });
        break;
      }

      case 'start-step': {
        parts.push({ type: 'step-start' });
        break;
      }
      case 'finish-step': {
        // A step boundary closes every open text/reasoning part id. This is what makes a
        // step boundary also a PART boundary — no text part straddles one — which the
        // resume/rollback work downstream depends on.
        activeTextParts = Object.create(null);
        activeReasoningParts = Object.create(null);
        break;
      }

      // Message-level frames. They carry id/metadata/finishReason, none of which is a
      // part, so the fold ignores them — matching the SDK, which only touches
      // `state.message.{id,metadata,finishReason}` here.
      case 'start':
      case 'finish':
      case 'message-metadata':
      case 'abort':
      case 'error':
        break;

      default: {
        // `data-*` parts, including the ones the routes write directly to the writer
        // (command-execution chips) — invisible to the projection this replaces.
        if (!frame.type.startsWith('data-')) break;
        const dataFrame = frame as unknown as {
          type: string;
          id?: string;
          data: unknown;
          transient?: boolean;
        };
        // Transient parts are control signals, not content: the SDK hands them to onData
        // and never puts them in the message. Persisting one would resurrect it on every
        // rejoin.
        if (dataFrame.transient) break;
        const existing =
          dataFrame.id != null
            ? parts.find((part) => part.type === dataFrame.type && part.id === dataFrame.id)
            : undefined;
        if (existing) existing.data = dataFrame.data;
        else parts.push({ ...dataFrame } as MutablePart);
        break;
      }
    }
  }

  return parts as unknown as AnyPart[];
};
