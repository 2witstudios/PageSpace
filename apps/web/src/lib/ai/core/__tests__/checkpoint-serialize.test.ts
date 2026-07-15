import { describe, it, expect } from 'vitest';
import {
  convergeRawParts,
  convergeRawPartsWithOrigins,
  capPartsToByteBudget,
  CHECKPOINT_MAX_SERIALIZED_BYTES,
} from '../checkpoint-serialize';

const text = (t: string) => ({ type: 'text' as const, text: t });
const toolInputAvailable = (toolCallId: string) => ({
  type: 'tool-list_pages' as const,
  toolCallId,
  toolName: 'list_pages',
  state: 'input-available' as const,
  input: { driveId: 'd1' },
});
const toolOutputAvailable = (toolCallId: string) => ({
  type: 'tool-list_pages' as const,
  toolCallId,
  toolName: 'list_pages',
  state: 'output-available' as const,
  input: { driveId: 'd1' },
  output: { pages: [] },
});
const tool = (toolCallId: string) => toolOutputAvailable(toolCallId);

describe('convergeRawParts', () => {
  it('given an empty buffer, should return an empty array', () => {
    expect(convergeRawParts([])).toEqual([]);
  });

  // The multicast registry buffers one entry per text-delta chunk — this is the reduction that
  // keeps the serialized snapshot from growing one entry per token.
  it('given consecutive text-delta parts, should merge them into a single text part', () => {
    expect(convergeRawParts([text('hel'), text('lo'), text(' world')])).toEqual([
      text('hello world'),
    ]);
  });

  it('given a tool part between two runs of text parts, should merge each run but keep the tool part as its own entry', () => {
    const toolPart = tool('tc1');
    expect(convergeRawParts([text('before'), toolPart, text('af'), text('ter')])).toEqual([
      text('before'),
      toolPart,
      text('after'),
    ]);
  });

  it('given only tool parts with distinct toolCallIds, should return them unchanged and in order', () => {
    const a = tool('tc1');
    const b = tool('tc2');
    expect(convergeRawParts([a, b])).toEqual([a, b]);
  });

  // The raw buffer carries a separate frame per tool-call state transition (input-available,
  // then output-available for the SAME toolCallId) — reusing appendPart converges these to the
  // latest state instead of persisting both, the same way the client's own live-append and
  // bootstrap-fold paths already do.
  it('given the same toolCallId appearing twice (input-available then output-available), should keep only the latest state', () => {
    const started = toolInputAvailable('tc1');
    const finished = toolOutputAvailable('tc1');
    expect(convergeRawParts([started, finished])).toEqual([finished]);
  });

  it('given a non-empty buffer, should not mutate the input array', () => {
    const initial = [text('hel'), text('lo')];
    const snapshot = JSON.parse(JSON.stringify(initial));
    convergeRawParts(initial);
    expect(initial).toEqual(snapshot);
  });
});

// One raw frame per merged part — the common case whenever nothing merges (no consecutive
// text-delta runs, no repeated toolCallId), so origin index == array index.
const identityOrigins = (parts: readonly unknown[]): number[] => parts.map((_, i) => i);

describe('capPartsToByteBudget', () => {
  it('given an empty array, should return it unchanged and report not capped', () => {
    expect(capPartsToByteBudget([], [], 1000)).toEqual({ parts: [], wasCapped: false, survivingFromRawIndex: 0 });
  });

  it('given parts under the byte budget, should return them unchanged and report not capped', () => {
    const parts = [text('hi'), text('there')];
    expect(capPartsToByteBudget(parts, identityOrigins(parts), CHECKPOINT_MAX_SERIALIZED_BYTES)).toEqual({
      parts,
      wasCapped: false,
      survivingFromRawIndex: 0,
    });
  });

  // Drop the OLDEST parts first — a rejoining client cares about the most recent content, not
  // the earliest, so the tail is what survives the cap.
  it('given parts over the byte budget, should drop the oldest parts and keep the tail', () => {
    const oldest = text('a'.repeat(50));
    const middle = text('b'.repeat(50));
    const newest = text('c'.repeat(50));
    const parts = [oldest, middle, newest];
    const result = capPartsToByteBudget(parts, identityOrigins(parts), 90);

    expect(result.wasCapped).toBe(true);
    expect(result.parts[result.parts.length - 1]).toEqual(newest);
    expect(result.parts).not.toContainEqual(oldest);
  });

  // Even when the newest single part alone exceeds the budget, capping must never return an
  // empty array — the persist path treats [] as "no live entry" and would silently wipe the
  // crash-recovery snapshot instead of merely truncating it.
  it('given the newest single part alone exceeds the budget, should still keep at least that one part', () => {
    const oldest = text('a'.repeat(50));
    const newest = text('b'.repeat(500));
    const parts = [oldest, newest];
    const result = capPartsToByteBudget(parts, identityOrigins(parts), 90);

    expect(result.wasCapped).toBe(true);
    expect(result.parts).toEqual([newest]);
  });

  it('given a custom maxBytes, should use it instead of the default cap', () => {
    const parts = [text('a'.repeat(10)), text('b'.repeat(10))];
    expect(capPartsToByteBudget(parts, identityOrigins(parts), 5).wasCapped).toBe(true);
    expect(capPartsToByteBudget(parts, identityOrigins(parts), 5_000_000).wasCapped).toBe(false);
  });

  // D-task yfz5p85c584z3ekvdfc3qx4e: rawPartsCount must reflect where the SURVIVING content
  // starts in the raw stream, not the total raw count — else the raw frames that fed the
  // DROPPED content get skipped by a rejoining client's live replay too, silently and
  // permanently losing it (the only place that content still exists once capped away here).
  describe('survivingFromRawIndex (rawPartsCount cap-trim fix)', () => {
    it('given no capping occurred, should report 0 (caller uses the raw total instead)', () => {
      const parts = [text('hi')];
      expect(capPartsToByteBudget(parts, [7], CHECKPOINT_MAX_SERIALIZED_BYTES).survivingFromRawIndex).toBe(0);
    });

    it('given one merged element dropped, should report the raw index that merged element started at', () => {
      const oldest = text('a'.repeat(50));
      const newest = text('b'.repeat(50));
      // oldest was first created by raw frame 3 (e.g. two earlier raw frames merged into it,
      // or it followed a tool part); newest started at raw frame 9.
      const result = capPartsToByteBudget([oldest, newest], [3, 9], 60);

      expect(result.wasCapped).toBe(true);
      expect(result.parts).toEqual([newest]);
      expect(result.survivingFromRawIndex).toBe(9);
    });

    it('given multiple merged elements dropped, should report the origin of the first SURVIVING element, not the last dropped one', () => {
      const a = text('a'.repeat(40));
      const b = text('b'.repeat(40));
      const c = text('c'.repeat(40));
      const result = capPartsToByteBudget([a, b, c], [0, 5, 12], 45);

      expect(result.wasCapped).toBe(true);
      expect(result.parts).toEqual([c]);
      expect(result.survivingFromRawIndex).toBe(12);
    });
  });
});

describe('convergeRawPartsWithOrigins', () => {
  it('given an empty buffer, should return an empty parts and origins array', () => {
    expect(convergeRawPartsWithOrigins([])).toEqual({ parts: [], originRawIndex: [] });
  });

  it('given parts with no merging (distinct tool calls), should map each merged element to its own raw index', () => {
    const a = tool('tc1');
    const b = tool('tc2');
    expect(convergeRawPartsWithOrigins([a, b])).toEqual({ parts: [a, b], originRawIndex: [0, 1] });
  });

  // Consecutive text-delta chunks fold into ONE merged element — its origin is the raw index of
  // the FIRST chunk that created it, not the last one that extended it.
  it('given consecutive text-delta parts merging into one element, should record the origin as the FIRST raw index, not the last', () => {
    const result = convergeRawPartsWithOrigins([text('hel'), text('lo'), text(' world')]);
    expect(result.parts).toEqual([text('hello world')]);
    expect(result.originRawIndex).toEqual([0]);
  });

  // A tool part's state transition (input-available → output-available) REPLACES the existing
  // merged element in place rather than appending a new one — so its origin must stay pinned to
  // where it was first created, not move to the raw index of the later transition.
  it('given a toolCallId updated by a later raw frame (state transition), should keep the origin at its FIRST appearance', () => {
    const started = toolInputAvailable('tc1');
    const finished = toolOutputAvailable('tc1');
    const result = convergeRawPartsWithOrigins([text('before'), started, text('mid'), finished]);

    expect(result.parts).toEqual([text('before'), finished, text('mid')]);
    // 'started' first appeared at raw index 1; its later replacement by 'finished' (raw index 3)
    // does not move that origin.
    expect(result.originRawIndex).toEqual([0, 1, 2]);
  });

  it('given a non-empty buffer, should not mutate the input array', () => {
    const initial = [text('hel'), text('lo')];
    const snapshot = JSON.parse(JSON.stringify(initial));
    convergeRawPartsWithOrigins(initial);
    expect(initial).toEqual(snapshot);
  });
});
