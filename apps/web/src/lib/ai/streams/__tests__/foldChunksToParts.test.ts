import { describe, it, expect } from 'vitest';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { createPartsFolder, foldChunksToParts } from '../foldChunksToParts';

/**
 * THE DIFFERENTIAL TEST. This is the point of `foldChunksToParts`.
 *
 * The module exists to be the AI SDK's own reduction of a `UIMessageChunk` log, so the
 * durable stream channel carries exactly what the HTTP response body carries. The
 * previous attempt at this (`chunkToPart`) was a hand-written four-case projection that
 * silently diverged for a year. A hand-written expectation table would reproduce that
 * failure mode: it pins what the author BELIEVED the SDK does.
 *
 * So each case below asserts our fold against the SDK's own reducer, reached through the
 * exported `readUIMessageStream`. When an `ai` upgrade changes the reduction, these fail
 * — which is the entire mechanism keeping the two channels from forking again.
 *
 * If one fails after an upgrade: fix `foldChunksToParts`. Do not relax the assertion, and
 * do not delete the case without recording the deliberate divergence in the module's
 * docblock (there is exactly one today — orphan tolerance, covered separately at the
 * bottom, and it cannot be expressed here because the SDK throws on those inputs).
 */

/**
 * `readUIMessageStream` only emits a snapshot when the reduction calls `write()`, and
 * `start-step` / `finish-step` deliberately do not. So a log ending on a step boundary
 * would have its final `step-start` part missing from the last emission — an artefact of
 * how we OBSERVE the SDK's state, not a difference in the reduction itself.
 *
 * A trailing `message-metadata` frame forces one final snapshot and pushes no part, so
 * the comparison sees the true end state. Our fold ignores the frame (same as the SDK,
 * which only touches `state.message.metadata`), so it is appended to both sides.
 */
const FORCE_FINAL_SNAPSHOT: UIMessageChunk = {
  type: 'message-metadata',
  messageMetadata: {},
} as UIMessageChunk;

const foldViaSdk = async (frames: readonly UIMessageChunk[]): Promise<UIMessage['parts']> => {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const frame of [...frames, FORCE_FINAL_SNAPSHOT]) controller.enqueue(frame);
      controller.close();
    },
  });

  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last?.parts ?? [];
};

/** Assert our fold equals the SDK's, and return the parts so a case can also pin shape. */
const expectMatchesSdk = async (frames: readonly UIMessageChunk[]): Promise<UIMessage['parts']> => {
  const [ours, theirs] = await Promise.all([
    foldChunksToParts([...frames, FORCE_FINAL_SNAPSHOT]),
    foldViaSdk(frames),
  ]);
  expect(ours).toEqual(theirs);
  return theirs;
};

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;

describe('foldChunksToParts — differential against the AI SDK reduction', () => {
  it('given a text part streamed by id, should match the SDK', async () => {
    const parts = await expectMatchesSdk([
      chunk({ type: 'start', messageId: 'm1' }),
      chunk({ type: 'start-step' }),
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'Hello' }),
      chunk({ type: 'text-delta', id: 't1', delta: ', world' }),
      chunk({ type: 'text-end', id: 't1' }),
    ]);

    expect(parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'Hello, world', state: 'done', providerMetadata: undefined },
    ]);
  });

  it('given interleaved text ids in one step, should match the SDK (both parts, no cross-contamination)', async () => {
    // Two concurrently-open text parts is exactly the case a positional "merge into the
    // last text part" reducer gets wrong — which is what the deleted projection did.
    await expectMatchesSdk([
      chunk({ type: 'text-start', id: 'a' }),
      chunk({ type: 'text-start', id: 'b' }),
      chunk({ type: 'text-delta', id: 'a', delta: 'AAA' }),
      chunk({ type: 'text-delta', id: 'b', delta: 'BBB' }),
      chunk({ type: 'text-delta', id: 'a', delta: '111' }),
      chunk({ type: 'text-end', id: 'b' }),
      chunk({ type: 'text-end', id: 'a' }),
    ]);
  });

  it('given the SAME text id reused after a finish-step, should match the SDK (two parts, not one)', async () => {
    // This is the invariant the rollback design downstream rests on: a step boundary
    // closes every open text id, so no text part straddles one.
    const parts = await expectMatchesSdk([
      chunk({ type: 'start-step' }),
      chunk({ type: 'text-start', id: 'shared' }),
      chunk({ type: 'text-delta', id: 'shared', delta: 'step one' }),
      chunk({ type: 'text-end', id: 'shared' }),
      chunk({ type: 'finish-step' }),
      chunk({ type: 'start-step' }),
      chunk({ type: 'text-start', id: 'shared' }),
      chunk({ type: 'text-delta', id: 'shared', delta: 'step two' }),
      chunk({ type: 'text-end', id: 'shared' }),
      chunk({ type: 'finish-step' }),
    ]);

    expect(parts.filter((part) => part.type === 'text')).toHaveLength(2);
  });

  it('given reasoning frames, should match the SDK', async () => {
    // Dropped entirely by the projection this replaces.
    const parts = await expectMatchesSdk([
      chunk({ type: 'reasoning-start', id: 'r1' }),
      chunk({ type: 'reasoning-delta', id: 'r1', delta: 'thinking' }),
      chunk({ type: 'reasoning-delta', id: 'r1', delta: ' harder' }),
      chunk({ type: 'reasoning-end', id: 'r1' }),
    ]);

    expect(parts).toEqual([
      { type: 'reasoning', text: 'thinking harder', state: 'done', providerMetadata: undefined },
    ]);
  });

  it('given a static tool call streamed through every state, should match the SDK', async () => {
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'list_pages' }),
      chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: '{"driveId"' }),
      chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: ':"d1"}' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
      }),
      chunk({
        type: 'tool-output-available',
        toolCallId: 'tc1',
        output: { pages: [{ id: 'p1' }] },
      }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      state: 'output-available',
      input: { driveId: 'd1' },
      output: { pages: [{ id: 'p1' }] },
    });
  });

  it('given a tool whose input is only partially streamed, should match the SDK (partial JSON parse)', async () => {
    // The reason the fold is async. A run that dies mid-tool-input leaves exactly this.
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'create_page' }),
      chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: '{"title":"Half wri' }),
    ]);

    expect(parts[0]).toMatchObject({ state: 'input-streaming' });
  });

  it('given a tool-output-error, should match the SDK', async () => {
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'run_bash' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'run_bash',
        input: { cmd: 'false' },
      }),
      chunk({ type: 'tool-output-error', toolCallId: 'tc1', errorText: 'exit 1' }),
    ]);

    expect(parts[0]).toMatchObject({ state: 'output-error', errorText: 'exit 1' });
  });

  it('given a tool-input-error, should match the SDK (rawInput on a static part)', async () => {
    await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'create_page' }),
      chunk({
        type: 'tool-input-error',
        toolCallId: 'tc1',
        toolName: 'create_page',
        input: '{"title": unterminated',
        errorText: 'invalid JSON',
      }),
    ]);
  });

  it('given providerMetadata on both a tool call and its result, should match the SDK (call vs result metadata are separate fields)', async () => {
    // The reduction routes providerMetadata to `callProviderMetadata` for input states
    // and `resultProviderMetadata` for output states. Nothing else in this suite sends
    // provider metadata on a tool frame, so without this case the branch is unpinned —
    // mutation-testing found it surviving.
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'web_search' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'web_search',
        input: { q: 'pagespace' },
        providerMetadata: { openrouter: { callId: 'call-1' } },
      }),
      chunk({
        type: 'tool-output-available',
        toolCallId: 'tc1',
        output: { results: [] },
        providerMetadata: { openrouter: { cost: 0.002 } },
      }),
    ]);

    expect(parts[0]).toMatchObject({
      callProviderMetadata: { openrouter: { callId: 'call-1' } },
      resultProviderMetadata: { openrouter: { cost: 0.002 } },
    });
  });

  it('given providerMetadata on a tool that ends in output-error, should match the SDK', async () => {
    await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'run_bash' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'run_bash',
        input: { cmd: 'false' },
        providerMetadata: { openrouter: { callId: 'call-2' } },
      }),
      chunk({
        type: 'tool-output-error',
        toolCallId: 'tc1',
        errorText: 'exit 1',
        providerMetadata: { openrouter: { cost: 0.001 } },
      }),
    ]);
  });

  it('given a tool-input-error for a call with no prior part, should match the SDK (part created straight into a result state)', async () => {
    // The only path that CREATES a tool part already in a result state, so the only one
    // that exercises the push branch's result-vs-call metadata routing. Mutation-testing
    // found that branch surviving without this.
    const parts = await expectMatchesSdk([
      chunk({
        type: 'tool-input-error',
        toolCallId: 'orphan',
        toolName: 'create_page',
        input: '{"title": unterminated',
        errorText: 'invalid JSON',
        providerMetadata: { openrouter: { callId: 'call-3' } },
      }),
    ]);

    expect(parts[0]).toMatchObject({
      type: 'tool-create_page',
      state: 'output-error',
      resultProviderMetadata: { openrouter: { callId: 'call-3' } },
    });
  });

  it('given a tool name containing hyphens, should match the SDK (name survives the type round trip)', async () => {
    // `tool-<name>` is parsed back out by splitting on '-', so a hyphenated name (MCP
    // tools routinely have them) is only preserved if the split rejoins the tail.
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'weather-api-v2' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'weather-api-v2',
        input: { city: 'Chicago' },
      }),
      chunk({ type: 'tool-output-available', toolCallId: 'tc1', output: { tempF: 71 } }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'tool-weather-api-v2', state: 'output-available' });
  });

  it('given a dynamic tool, should match the SDK', async () => {
    const parts = await expectMatchesSdk([
      chunk({
        type: 'tool-input-start',
        toolCallId: 'mcp1',
        toolName: 'mcp__weather',
        dynamic: true,
      }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'mcp1',
        toolName: 'mcp__weather',
        input: { city: 'Chicago' },
        dynamic: true,
      }),
      chunk({ type: 'tool-output-available', toolCallId: 'mcp1', output: { tempF: 71 } }),
    ]);

    expect(parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'mcp__weather',
      state: 'output-available',
    });
  });

  it('given a tool-input-error whose dynamic flag disagrees with the existing part, should match the SDK (the existing part wins)', async () => {
    // The reduction decides dynamic-ness from the part it already has, falling back to
    // the frame's flag only when there is none. Trusting the frame instead would fail to
    // find the dynamic part and push a SECOND, static one for the same toolCallId.
    const parts = await expectMatchesSdk([
      chunk({
        type: 'tool-input-start',
        toolCallId: 'tc1',
        toolName: 'mcp__fetch',
        dynamic: true,
      }),
      chunk({
        type: 'tool-input-error',
        toolCallId: 'tc1',
        toolName: 'mcp__fetch',
        input: '{"url": broken',
        errorText: 'invalid JSON',
        // dynamic deliberately omitted — disagrees with the part above
      }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'dynamic-tool', state: 'output-error' });
  });

  it('given a DYNAMIC tool that errors on output, should match the SDK (keeps its own toolName)', async () => {
    // The output-error path reads the tool's name back off the invocation, and a dynamic
    // part carries it in a different place than a static one (`toolName` vs the `tool-`
    // prefix of `type`). The existing dynamic case ends in output-AVAILABLE and the
    // existing output-error case is static, so neither crosses this branch.
    const parts = await expectMatchesSdk([
      chunk({
        type: 'tool-input-start',
        toolCallId: 'mcp1',
        toolName: 'mcp__weather',
        dynamic: true,
      }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'mcp1',
        toolName: 'mcp__weather',
        input: { city: 'Chicago' },
        dynamic: true,
      }),
      chunk({ type: 'tool-output-error', toolCallId: 'mcp1', errorText: 'upstream 503' }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'mcp__weather',
      state: 'output-error',
      errorText: 'upstream 503',
    });
  });

  it('given title and toolMetadata arriving on a LATER frame, should match the SDK (carried onto the existing part)', async () => {
    // The display fields are optional on every tool frame, so they can arrive on the
    // input-available rather than the input-start — the update path has to take them, and
    // only when they are present. Both are also asserted to SURVIVE the output frame that
    // does not resend them, which is what makes them part identity rather than per-frame.
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'search' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'search',
        input: { q: 'x' },
        title: 'Searching the drive',
        toolMetadata: { surface: 'page' },
      }),
      chunk({ type: 'tool-output-available', toolCallId: 'tc1', output: { hits: 3 } }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool-search',
      state: 'output-available',
      title: 'Searching the drive',
      toolMetadata: { surface: 'page' },
    });
  });

  it('given toolMetadata on the frame that CREATES the part, should match the SDK', async () => {
    // The push path, not the update path — no `tool-input-start` opened this one.
    const parts = await expectMatchesSdk([
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc2',
        toolName: 'search',
        input: { q: 'y' },
        toolMetadata: { surface: 'global' },
      }),
    ]);

    expect(parts[0]).toMatchObject({ toolMetadata: { surface: 'global' } });
  });

  it('given a file part carrying providerMetadata, should match the SDK', async () => {
    const parts = await expectMatchesSdk([
      chunk({
        type: 'file',
        mediaType: 'image/png',
        url: 'https://example.test/a.png',
        providerMetadata: { openai: { imageId: 'img_1' } },
      }),
    ]);

    expect(parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      providerMetadata: { openai: { imageId: 'img_1' } },
    });
  });

  it('given providerMetadata on a CALL-state frame that creates the part, should match the SDK', async () => {
    // Two branches meet here and only together: the part is PUSHED rather than updated
    // (no `tool-input-start` opened it first), and the state is a call rather than a
    // result — so the metadata lands under `callProviderMetadata`. The existing metadata
    // cases all update a part that already exists, or carry a result state.
    const parts = await expectMatchesSdk([
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc-meta',
        toolName: 'search',
        input: { q: 'x' },
        providerMetadata: { openai: { cachedTokens: 12 } },
      }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool-search',
      state: 'input-available',
      callProviderMetadata: { openai: { cachedTokens: 12 } },
    });
  });

  it('given a tool approval request then denial, should match the SDK', async () => {
    await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'delete_page' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'delete_page',
        input: { pageId: 'p1' },
      }),
      chunk({
        type: 'tool-approval-request',
        toolCallId: 'tc1',
        approvalId: 'ap1',
        signature: 'sig-1',
      }),
      chunk({ type: 'tool-output-denied', toolCallId: 'tc1' }),
    ]);
  });

  it('given a tool approval request with no signature, should match the SDK (no empty signature key)', async () => {
    const parts = await expectMatchesSdk([
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'delete_page' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'delete_page',
        input: { pageId: 'p1' },
      }),
      chunk({ type: 'tool-approval-request', toolCallId: 'tc1', approvalId: 'ap1' }),
    ]);

    expect(parts[0]).toMatchObject({ approval: { id: 'ap1' } });
  });

  it('given file and source frames, should match the SDK', async () => {
    // All three dropped by the projection this replaces.
    const parts = await expectMatchesSdk([
      chunk({ type: 'file', mediaType: 'image/png', url: 'https://example.test/a.png' }),
      chunk({
        type: 'source-url',
        sourceId: 's1',
        url: 'https://example.test/doc',
        title: 'Doc',
      }),
      chunk({
        type: 'source-document',
        sourceId: 's2',
        mediaType: 'application/pdf',
        title: 'Spec',
        filename: 'spec.pdf',
      }),
    ]);

    expect(parts.map((part) => part.type)).toEqual(['file', 'source-url', 'source-document']);
  });

  it('given a data part written directly by the route, should match the SDK', async () => {
    // The command-execution chips the routes write straight to the writer. Structurally
    // invisible to an onChunk-based projection, which never sees writer.write() output.
    const parts = await expectMatchesSdk([
      chunk({
        type: 'data-commandExecution',
        id: 'm1-command-0',
        data: { command: 'summarize', status: 'used' },
      }),
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'ok' }),
      chunk({ type: 'text-end', id: 't1' }),
    ]);

    expect(parts[0]).toMatchObject({ type: 'data-commandExecution', id: 'm1-command-0' });
  });

  it('given a data part re-sent with the same id, should match the SDK (replace, not append)', async () => {
    const parts = await expectMatchesSdk([
      chunk({ type: 'data-progress', id: 'p', data: { pct: 10 } }),
      chunk({ type: 'data-progress', id: 'p', data: { pct: 90 } }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ data: { pct: 90 } });
  });

  it('given data parts with NO id, should match the SDK (each appends; none replaces)', async () => {
    // `id` is optional on a data frame. Without one there is nothing to match against, so
    // every frame is a new part — the opposite of the same-id case above, and the branch
    // the same-id test cannot reach.
    const parts = await expectMatchesSdk([
      chunk({ type: 'data-progress', data: { pct: 10 } }),
      chunk({ type: 'data-progress', data: { pct: 90 } }),
    ]);

    expect(parts).toHaveLength(2);
    expect(parts.map((part) => (part as { data: { pct: number } }).data.pct)).toEqual([10, 90]);
  });

  it('given a transient data part, should match the SDK (never becomes content)', async () => {
    const parts = await expectMatchesSdk([
      chunk({ type: 'data-notice', id: 'n1', data: { text: 'ephemeral' }, transient: true }),
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'kept' }),
      chunk({ type: 'text-end', id: 't1' }),
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text' });
  });

  it('given providerMetadata on text frames, should match the SDK', async () => {
    await expectMatchesSdk([
      chunk({ type: 'text-start', id: 't1', providerMetadata: { openrouter: { cached: true } } }),
      chunk({ type: 'text-delta', id: 't1', delta: 'hi' }),
      chunk({ type: 'text-end', id: 't1', providerMetadata: { openrouter: { cached: false } } }),
    ]);
  });

  it('given a full multi-step agent turn, should match the SDK end to end', async () => {
    // The composite case: reasoning, a tool round trip, a route-written data part, two
    // steps, and a trailing answer — i.e. an ordinary agent reply, all of whose
    // non-text/tool content the previous projection discarded.
    const parts = await expectMatchesSdk([
      chunk({ type: 'start', messageId: 'm1' }),
      chunk({ type: 'data-commandExecution', id: 'm1-command-0', data: { command: 'plan' } }),
      chunk({ type: 'start-step' }),
      chunk({ type: 'reasoning-start', id: 'r1' }),
      chunk({ type: 'reasoning-delta', id: 'r1', delta: 'I should look this up' }),
      chunk({ type: 'reasoning-end', id: 'r1' }),
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'search_pages' }),
      chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: '{"q":"invoices"}' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'search_pages',
        input: { q: 'invoices' },
      }),
      chunk({ type: 'finish-step' }),
      chunk({ type: 'tool-output-available', toolCallId: 'tc1', output: { hits: 3 } }),
      chunk({ type: 'start-step' }),
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'Found 3 invoices.' }),
      chunk({ type: 'text-end', id: 't1' }),
      chunk({ type: 'finish-step' }),
      chunk({ type: 'finish' }),
    ]);

    expect(parts.map((part) => part.type)).toEqual([
      'data-commandExecution',
      'step-start',
      'reasoning',
      'tool-search_pages',
      'step-start',
      'text',
    ]);
  });
});

describe('foldChunksToParts — deliberate divergences and invariants', () => {
  /**
   * The one place the fold is NOT the SDK, and why. The SDK throws
   * `UIMessageStreamError` on a frame naming a part it never saw start, because it is
   * reducing a live stream it produced itself — there, that is a real protocol violation.
   *
   * We fold a PERSISTED log that can legitimately begin mid-stream: the in-memory frame
   * ring evicts its oldest entries on a long run, and a rejoining client folds from a
   * cursor. Throwing would turn "the start of a long reply aged out" into "this reply
   * cannot be rendered at all". These cases cannot be written as differential tests —
   * the SDK side rejects the input by design.
   */
  it('given a log starting mid-stream, should skip orphaned frames rather than throw', async () => {
    // EVERY frame type that closes over something opened earlier is listed here, because
    // this is exactly what a log that begins mid-stream contains: the tail of parts whose
    // opening frames were evicted. The SDK's own reduction THROWS on several of these
    // (`getToolInvocation`); skipping them is the deliberate divergence, and it is only
    // worth anything if it holds for all of them rather than the two we happened to try.
    const parts = await foldChunksToParts([
      chunk({ type: 'text-delta', id: 'gone', delta: 'orphan' }),
      chunk({ type: 'text-end', id: 'gone' }),
      chunk({ type: 'reasoning-delta', id: 'gone-r', delta: 'orphan' }),
      chunk({ type: 'reasoning-end', id: 'gone-r' }),
      chunk({ type: 'tool-input-delta', toolCallId: 'gone', inputTextDelta: '{"a":' }),
      chunk({ type: 'tool-output-available', toolCallId: 'gone', output: {} }),
      chunk({ type: 'tool-output-error', toolCallId: 'gone', errorText: 'nope' }),
      chunk({ type: 'tool-output-denied', toolCallId: 'gone' }),
      chunk({ type: 'tool-approval-request', toolCallId: 'gone', approvalId: 'a1' }),
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'survivor' }),
      chunk({ type: 'text-end', id: 't1' }),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'survivor', state: 'done', providerMetadata: undefined },
    ]);
  });

  it('given a frame type the fold does not know, should ignore it rather than treat it as data', async () => {
    // The default case is where `data-*` parts are handled, so it is also where any FUTURE
    // SDK frame lands. Anything not prefixed `data-` has no part to contribute, and must
    // not be pushed as one — a forward-compatibility guarantee, since a newer server can
    // stream a frame this build has never heard of.
    const parts = await foldChunksToParts([
      chunk({ type: 'some-future-frame', payload: { whatever: true } }),
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'kept' }),
      chunk({ type: 'text-end', id: 't1' }),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'kept', state: 'done', providerMetadata: undefined },
    ]);
  });

  it('given the same frames folded twice, should be pure — no mutation of the input log', async () => {
    const frames = [
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'once' }),
      chunk({ type: 'text-end', id: 't1' }),
      chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'noop' }),
      chunk({
        type: 'tool-input-available',
        toolCallId: 'tc1',
        toolName: 'noop',
        input: { a: 1 },
      }),
    ];
    const snapshot = structuredClone(frames);

    const first = await foldChunksToParts(frames);
    const second = await foldChunksToParts(frames);

    expect(frames).toEqual(snapshot);
    expect(second).toEqual(first);
  });

  it('given an empty log, should return no parts', async () => {
    expect(await foldChunksToParts([])).toEqual([]);
  });

  /**
   * The step-boundary invariant, pinned directly.
   *
   * The differential case above ("same text id reused after a finish-step") does NOT pin
   * this: a fresh `text-start` overwrites the map entry either way, so it passes even
   * with the reset deleted. Mutation-testing caught that.
   *
   * Nor does closing the part with `text-end` first — `text-end` already deletes the id
   * from the active map, so the reset is a no-op for it. (An earlier version of this test
   * did exactly that and survived the mutant. Left as a warning: the reset's ONLY
   * observable effect is on a text part still OPEN when the boundary arrives.)
   *
   * That input throws in the SDK, so it cannot be expressed differentially — but it has
   * to be pinned somewhere, because the downstream resume/rollback design rests on it:
   * truncating the frame log to a step boundary is only a clean cut if no text part
   * straddles one. Without the reset a stale delta silently appends to the previous
   * step's part and un-does the boundary.
   *
   * Note the surviving part keeps `state: 'streaming'` — a step boundary stops TRACKING
   * an open part, it does not mark it done. That matches the SDK, which only clears the
   * maps here.
   */
  it('given a text-delta for an id left open across a finish-step, should treat it as orphaned rather than append to the previous step', async () => {
    const parts = await foldChunksToParts([
      chunk({ type: 'start-step' }),
      chunk({ type: 'text-start', id: 'shared' }),
      chunk({ type: 'text-delta', id: 'shared', delta: 'step one' }),
      // No text-end: the part is still open when the boundary lands.
      chunk({ type: 'finish-step' }),
      chunk({ type: 'text-delta', id: 'shared', delta: ' LEAKED' }),
    ]);

    expect(parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'step one', state: 'streaming', providerMetadata: undefined },
    ]);
  });

  it('given a reasoning-delta for an id left open across a finish-step, should treat it as orphaned', async () => {
    const parts = await foldChunksToParts([
      chunk({ type: 'reasoning-start', id: 'r1' }),
      chunk({ type: 'reasoning-delta', id: 'r1', delta: 'step one' }),
      chunk({ type: 'finish-step' }),
      chunk({ type: 'reasoning-delta', id: 'r1', delta: ' LEAKED' }),
    ]);

    expect(parts).toEqual([
      { type: 'reasoning', text: 'step one', state: 'streaming', providerMetadata: undefined },
    ]);
  });

  it('given a text-delta after that id was closed by text-end, should treat it as orphaned', async () => {
    // `text-end` removes the id from the active map, so a later delta for it has no
    // target. Without that removal the delta would append to an already-'done' part.
    // The SDK throws on this input, so it cannot be expressed differentially.
    const parts = await foldChunksToParts([
      chunk({ type: 'text-start', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: 'complete' }),
      chunk({ type: 'text-end', id: 't1' }),
      chunk({ type: 'text-delta', id: 't1', delta: ' LEAKED' }),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'complete', state: 'done', providerMetadata: undefined },
    ]);
  });

  it('given a part id that shadows an Object prototype key, should not collide', async () => {
    // The SDK uses Object.create(null) for its active-part maps; so do we. A plain object
    // would resolve `activeTextParts['constructor']` to the inherited function and
    // "successfully" append text to it.
    const parts = await foldChunksToParts([
      chunk({ type: 'text-start', id: '__proto__' }),
      chunk({ type: 'text-delta', id: '__proto__', delta: 'safe' }),
      chunk({ type: 'text-end', id: '__proto__' }),
      chunk({ type: 'text-delta', id: 'constructor', delta: 'orphan' }),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'safe', state: 'done', providerMetadata: undefined },
    ]);
  });
});

describe('createPartsFolder — incremental equivalence', () => {
  const AGENT_TURN = [
    chunk({ type: 'start', messageId: 'm1' }),
    chunk({ type: 'data-commandExecution', id: 'm1-command-0', data: { command: 'plan' } }),
    chunk({ type: 'start-step' }),
    chunk({ type: 'reasoning-start', id: 'r1' }),
    chunk({ type: 'reasoning-delta', id: 'r1', delta: 'looking it up' }),
    chunk({ type: 'reasoning-end', id: 'r1' }),
    chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'search_pages' }),
    chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: '{"q":"invoices"}' }),
    chunk({
      type: 'tool-input-available',
      toolCallId: 'tc1',
      toolName: 'search_pages',
      input: { q: 'invoices' },
    }),
    chunk({ type: 'tool-output-available', toolCallId: 'tc1', output: { hits: 3 } }),
    chunk({ type: 'finish-step' }),
    chunk({ type: 'start-step' }),
    chunk({ type: 'text-start', id: 't1' }),
    chunk({ type: 'text-delta', id: 't1', delta: 'Found ' }),
    chunk({ type: 'text-delta', id: 't1', delta: '3 invoices.' }),
    chunk({ type: 'text-end', id: 't1' }),
    chunk({ type: 'finish-step' }),
  ];

  it('given frames pushed one at a time, should equal folding them in one batch', async () => {
    // The incremental folder is what a live subscriber uses; the batch fold is what the
    // differential test above pins against the SDK. If these two ever disagree, the
    // subscriber's view is no longer the SDK's reduction — i.e. the fork is back.
    const folder = createPartsFolder();
    for (const frame of AGENT_TURN) await folder.push(frame);

    expect(folder.parts).toEqual(await foldChunksToParts(AGENT_TURN));
  });

  it('given a prefix of the log, should equal folding that prefix in one batch (every intermediate state)', async () => {
    // Not just the end state: a rejoining client renders the folder's view at every
    // intermediate point, so each prefix has to match too.
    const folder = createPartsFolder();
    for (let i = 0; i < AGENT_TURN.length; i += 1) {
      await folder.push(AGENT_TURN[i]);
      expect(folder.parts).toEqual(await foldChunksToParts(AGENT_TURN.slice(0, i + 1)));
    }
  });

  it('given repeated reads, should hand out fresh part objects each time', async () => {
    // The fold mutates its parts in place (mirroring the SDK). If `.parts` leaked those
    // objects, a memoized React consumer would see a text part whose reference never
    // changes while its text grows — rendering once and then going stale.
    const folder = createPartsFolder();
    await folder.push(chunk({ type: 'text-start', id: 't1' }));
    await folder.push(chunk({ type: 'text-delta', id: 't1', delta: 'one' }));

    const first = folder.parts;
    await folder.push(chunk({ type: 'text-delta', id: 't1', delta: ' two' }));
    const second = folder.parts;

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]).toMatchObject({ text: 'one' });
    expect(second[0]).toMatchObject({ text: 'one two' });
  });

  it('given a caller that mutates the returned parts, should not corrupt the folder', async () => {
    const folder = createPartsFolder();
    await folder.push(chunk({ type: 'text-start', id: 't1' }));
    await folder.push(chunk({ type: 'text-delta', id: 't1', delta: 'safe' }));

    const leaked = folder.parts as unknown as { text: string }[];
    leaked[0].text = 'CLOBBERED';
    leaked.push({ text: 'injected' });

    expect(folder.parts).toEqual([
      { type: 'text', text: 'safe', state: 'streaming', providerMetadata: undefined },
    ]);
  });
});
