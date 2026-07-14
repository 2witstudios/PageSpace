import { describe, it, expect } from 'vitest';
import {
  convergeRawParts,
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

describe('capPartsToByteBudget', () => {
  it('given an empty array, should return it unchanged and report not capped', () => {
    expect(capPartsToByteBudget([], 1000)).toEqual({ parts: [], wasCapped: false });
  });

  it('given parts under the byte budget, should return them unchanged and report not capped', () => {
    const parts = [text('hi'), text('there')];
    expect(capPartsToByteBudget(parts, CHECKPOINT_MAX_SERIALIZED_BYTES)).toEqual({
      parts,
      wasCapped: false,
    });
  });

  // Drop the OLDEST parts first — a rejoining client cares about the most recent content, not
  // the earliest, so the tail is what survives the cap.
  it('given parts over the byte budget, should drop the oldest parts and keep the tail', () => {
    const oldest = text('a'.repeat(50));
    const middle = text('b'.repeat(50));
    const newest = text('c'.repeat(50));
    const result = capPartsToByteBudget([oldest, middle, newest], 90);

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
    const result = capPartsToByteBudget([oldest, newest], 90);

    expect(result.wasCapped).toBe(true);
    expect(result.parts).toEqual([newest]);
  });

  it('given a custom maxBytes, should use it instead of the default cap', () => {
    const parts = [text('a'.repeat(10)), text('b'.repeat(10))];
    expect(capPartsToByteBudget(parts, 5).wasCapped).toBe(true);
    expect(capPartsToByteBudget(parts, 5_000_000).wasCapped).toBe(false);
  });
});
