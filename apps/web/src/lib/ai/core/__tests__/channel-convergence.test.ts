import { describe, it, expect } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { openStreamChannel } from '@/lib/ai/core/stream-channel';
import { pumpSdkStreamToChannel } from '@/lib/ai/core/pump-sdk-stream';
import { foldChunksToParts, createPartsFolder } from '@/lib/ai/streams/foldChunksToParts';

/**
 * THE EPIC'S CENTRAL CLAIM, tested end to end through the real pipeline.
 *
 * "One channel" is only true if everyone reading it arrives at the same message. So this asks
 * the question directly: does a client that reads the HTTP response body from the start, a
 * client that joins halfway, and a client that arrives after the whole thing finished, all
 * reconstruct the SAME parts?
 *
 * Before this change they demonstrably did not, and could not. The body carried the SDK's real
 * `UIMessageChunk`s; every other reader got `chunkToPart`'s four-case projection with no
 * reasoning, files, sources, step boundaries or route-written `data-*` parts. Divergence was
 * the design, not a bug in it.
 *
 * Nothing here is mocked except the SDK stream's contents: a real channel, the real pump, the
 * real fold, the real cursor arithmetic. It is the closest thing to running the app that does
 * not need a browser — deliberately, because the browser-only acceptance sentences (two
 * conversations at once, a second device) need React and a real `useChat`, and these do not.
 */

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;

/**
 * An ordinary agent turn: a route-written command chip, reasoning, a tool round trip across a
 * step boundary, then the answer. Every category the deleted projection dropped is present on
 * purpose — a convergence test built only from text would pass even with the fork still in.
 */
const AGENT_TURN: UIMessageChunk[] = [
  chunk({ type: 'start', messageId: 'm1' }),
  chunk({ type: 'data-commandExecution', id: 'm1-command-0', data: { command: 'summarize' } }),
  chunk({ type: 'start-step' }),
  chunk({ type: 'reasoning-start', id: 'r1' }),
  chunk({ type: 'reasoning-delta', id: 'r1', delta: 'I should look up the invoices' }),
  chunk({ type: 'reasoning-end', id: 'r1' }),
  chunk({ type: 'tool-input-start', toolCallId: 'tc1', toolName: 'search_pages' }),
  chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: '{"q":"inv' }),
  chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: 'oices"}' }),
  chunk({
    type: 'tool-input-available',
    toolCallId: 'tc1',
    toolName: 'search_pages',
    input: { q: 'invoices' },
  }),
  chunk({ type: 'finish-step' }),
  chunk({ type: 'tool-output-available', toolCallId: 'tc1', output: { hits: 3 } }),
  chunk({ type: 'source-url', sourceId: 's1', url: 'https://example.test/inv', title: 'Invoices' }),
  chunk({ type: 'file', mediaType: 'image/png', url: 'https://example.test/chart.png' }),
  chunk({ type: 'start-step' }),
  // Deliberately reuses `r1`, which was a REASONING id in the first step, as a TEXT id here.
  // Providers recycle part ids, and the fold keeps text and reasoning in separate maps — one
  // shared map would collide and fold this turn into a different message.
  //
  // It does NOT exercise the finish-step reset: `r1` never entered the text map in step one, so
  // removing that reset changes nothing here (mutation-tested — the mutant survives, and it is
  // meant to). The reset's own invariant is pinned directly in foldChunksToParts.test.ts, on
  // the only input that observes it: a text part left OPEN across the boundary.
  chunk({ type: 'text-start', id: 'r1' }),
  chunk({ type: 'text-delta', id: 'r1', delta: 'Found 3 invoices' }),
  chunk({ type: 'text-delta', id: 'r1', delta: ' totalling £4,200.' }),
  chunk({ type: 'text-end', id: 'r1' }),
  chunk({ type: 'finish-step' }),
  chunk({ type: 'finish' }),
];

const sdkStreamOf = (frames: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });

/** Drain a response-shaped stream and fold it, exactly as the browser would. */
const readAndFold = async (stream: ReadableStream<UIMessageChunk>) => {
  const collected: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) collected.push(value);
  }
  return foldChunksToParts(collected);
};

/**
 * Fold the way a JOINER does: seeded from the server's checkpoint snapshot of everything before
 * the cursor, then fed live frames from the cursor on. This mirrors the real bootstrap —
 * `/active-streams` seeds `parts`, then the SSE join delivers `fromSeq` onward.
 */
const joinFromCursor = async (
  channel: ReturnType<typeof openStreamChannel>,
  fromSeq: number,
) => {
  const folder = createPartsFolder();

  // The seed: the server's checkpoint of everything strictly before the cursor.
  for (const frame of channel.getFrames(0).slice(0, fromSeq)) await folder.push(frame);

  // The live half goes through `subscribe`, which is the path production actually uses.
  //
  // It used to read `getFrames(fromSeq)` here, and that made the test blind: an off-by-one in
  // getFrames shifted the seed and the live half by the same frame, so the two errors cancelled
  // and a seeded mutant survived. Driving the live half through the real subscription means the
  // cursor is exercised exactly once, where it can be wrong.
  const live: UIMessageChunk[] = [];
  channel.subscribe({
    fromSeq,
    onFrame: ({ chunk: frame }) => live.push(frame),
    onEnd: () => {},
  })();
  for (const frame of live) await folder.push(frame);

  return folder.parts;
};

describe('channel convergence — every reader reconstructs the same message', () => {
  it('given a client reading from the start, should reconstruct the full turn including reasoning, sources, files and route-written data parts', async () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const body = channel.subscribeReadable({ fromSeq: 0 });
    await pumpSdkStreamToChannel(sdkStreamOf(AGENT_TURN), channel);
    channel.finish(false);

    const parts = await readAndFold(body);

    expect(parts.map((part) => part.type)).toEqual([
      'data-commandExecution',
      'step-start',
      'reasoning',
      'tool-search_pages',
      'source-url',
      'file',
      'step-start',
      'text',
    ]);
  });

  it('given a client that joins at EVERY possible mid-stream point, should converge on exactly what the body carried', async () => {
    // The claim, exhaustively: not "a joiner works" but "a joiner works from any cursor".
    // A single sampled offset would miss an off-by-one at a step or tool boundary, which is
    // precisely where the old skip-count arithmetic went wrong.
    const channel = openStreamChannel({ messageId: 'm1' });
    const body = channel.subscribeReadable({ fromSeq: 0 });
    await pumpSdkStreamToChannel(sdkStreamOf(AGENT_TURN), channel);
    channel.finish(false);

    const canonical = await readAndFold(body);

    for (let cursor = 0; cursor <= AGENT_TURN.length; cursor += 1) {
      expect(
        await joinFromCursor(channel, cursor),
        `a joiner attaching at seq ${cursor} diverged from the response body`,
      ).toEqual(canonical);
    }
  });

  it('given a client that arrives only AFTER the stream finished, should still reconstruct the whole message', async () => {
    // The ordinary race: the socket event lands a beat after the run ended. Getting an empty
    // stream here is the "my reply vanished" symptom.
    const channel = openStreamChannel({ messageId: 'm1' });
    await pumpSdkStreamToChannel(sdkStreamOf(AGENT_TURN), channel);
    channel.finish(false);

    const late = channel.subscribeReadable({ fromSeq: 0 });

    expect(await readAndFold(late)).toEqual(await foldChunksToParts(AGENT_TURN));
  });

  it('given the response reader disconnects mid-stream, should still capture the rest — and a later joiner sees the whole message', async () => {
    // "Send a message and leave." The disconnect drops one subscription; the record completes,
    // and someone attaching afterwards gets everything, not just the prefix the first reader saw.
    const channel = openStreamChannel({ messageId: 'm1' });
    const body = channel.subscribeReadable({ fromSeq: 0 });
    const reader = body.getReader();

    const half = Math.floor(AGENT_TURN.length / 2);
    for (const frame of AGENT_TURN.slice(0, half)) channel.append(frame);
    await reader.read();
    await reader.cancel();

    for (const frame of AGENT_TURN.slice(half)) channel.append(frame);
    channel.finish(false);

    expect(await joinFromCursor(channel, 0)).toEqual(await foldChunksToParts(AGENT_TURN));
  });

  it('given nobody ever subscribes, should still hold the complete message for whoever asks later', async () => {
    // The fully-AFK case. No response reader was ever created.
    const channel = openStreamChannel({ messageId: 'm1' });
    await pumpSdkStreamToChannel(sdkStreamOf(AGENT_TURN), channel);

    expect(await foldChunksToParts(channel.getFrames())).toEqual(
      await foldChunksToParts(AGENT_TURN),
    );
  });

  it('given the checkpoint snapshot the bootstrap serves, should equal what a live reader has at that point', async () => {
    // `/active-streams` seeds a rejoining client from the checkpoint. If that snapshot and the
    // live view disagree, the client renders a seam at the join — which is what the merged-vs-raw
    // representations used to produce.
    const channel = openStreamChannel({ messageId: 'm1' });
    for (const frame of AGENT_TURN.slice(0, 12)) channel.append(frame);

    const snapshot = await foldChunksToParts(channel.getFrames());
    const live = await joinFromCursor(channel, 0);

    expect(snapshot).toEqual(live);
  });
});
