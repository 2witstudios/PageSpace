import { describe, it, expect } from 'vitest';
import {
  parseStreamingConversationIds,
  addStreamingConversation,
  removeStreamingConversation,
  applyPendingDeltas,
} from '../streamingConversationIds';

describe('parseStreamingConversationIds', () => {
  it('given a response with streams, should return the set of their conversationIds', () => {
    const result = parseStreamingConversationIds({
      streams: [{ conversationId: 'conv-1' }, { conversationId: 'conv-2' }],
    });
    expect(result).toEqual(new Set(['conv-1', 'conv-2']));
  });

  it('given duplicate conversationIds, should dedupe', () => {
    const result = parseStreamingConversationIds({
      streams: [{ conversationId: 'conv-1' }, { conversationId: 'conv-1' }],
    });
    expect(result).toEqual(new Set(['conv-1']));
  });

  it('given no streams field, should return an empty set', () => {
    expect(parseStreamingConversationIds({})).toEqual(new Set());
  });

  it('given null/undefined, should return an empty set', () => {
    expect(parseStreamingConversationIds(null)).toEqual(new Set());
    expect(parseStreamingConversationIds(undefined)).toEqual(new Set());
  });

  it('given an empty streams array, should return an empty set', () => {
    expect(parseStreamingConversationIds({ streams: [] })).toEqual(new Set());
  });
});

describe('addStreamingConversation', () => {
  it('given a conversationId not already present, should add it', () => {
    const result = addStreamingConversation(new Set(['conv-1']), 'conv-2');
    expect(result).toEqual(new Set(['conv-1', 'conv-2']));
  });

  it('given a conversationId already present, should return the SAME set reference (no-op)', () => {
    const original = new Set(['conv-1']);
    const result = addStreamingConversation(original, 'conv-1');
    expect(result).toBe(original);
  });

  it('given an empty set, should not mutate the input', () => {
    const original = new Set<string>();
    addStreamingConversation(original, 'conv-1');
    expect(original).toEqual(new Set());
  });
});

describe('removeStreamingConversation', () => {
  it('given a present conversationId, should remove it', () => {
    const result = removeStreamingConversation(new Set(['conv-1', 'conv-2']), 'conv-1');
    expect(result).toEqual(new Set(['conv-2']));
  });

  it('given an absent conversationId, should return the SAME set reference (no-op)', () => {
    const original = new Set(['conv-1']);
    const result = removeStreamingConversation(original, 'conv-99');
    expect(result).toBe(original);
  });

  it('given the last remaining conversationId, should return an empty set', () => {
    const result = removeStreamingConversation(new Set(['conv-1']), 'conv-1');
    expect(result).toEqual(new Set());
  });

  it('should not mutate the input set', () => {
    const original = new Set(['conv-1']);
    removeStreamingConversation(original, 'conv-1');
    expect(original).toEqual(new Set(['conv-1']));
  });
});

// Simplification-finder review finding: the fetch effect used to REPLACE state wholesale,
// silently dropping any chat:stream_start/complete that landed while the fetch was in flight.
describe('applyPendingDeltas', () => {
  it('given no deltas, should return the SAME fetched set reference (no-op)', () => {
    const fetched = new Set(['conv-1']);
    const result = applyPendingDeltas(fetched, new Map());
    expect(result).toBe(fetched);
  });

  it('given an add delta for an id not in the fetched snapshot, should add it', () => {
    // A stream that started AFTER the fetch was dispatched but BEFORE it resolved — the
    // snapshot predates it, so the fetch alone would have dropped it.
    const fetched = new Set(['conv-1']);
    const result = applyPendingDeltas(fetched, new Map([['conv-2', 'add']]));
    expect(result).toEqual(new Set(['conv-1', 'conv-2']));
  });

  it('given a remove delta for an id present in the fetched snapshot, should remove it', () => {
    // A stream that completed AFTER the fetch was dispatched but BEFORE it resolved — the
    // snapshot (taken while it was still streaming) predates the completion.
    const fetched = new Set(['conv-1', 'conv-2']);
    const result = applyPendingDeltas(fetched, new Map([['conv-2', 'remove']]));
    expect(result).toEqual(new Set(['conv-1']));
  });

  it('given a remove delta for an id NOT in the fetched snapshot, should be a no-op for that id', () => {
    const fetched = new Set(['conv-1']);
    const result = applyPendingDeltas(fetched, new Map([['conv-99', 'remove']]));
    expect(result).toEqual(new Set(['conv-1']));
  });

  it('given multiple deltas, should apply all of them', () => {
    const fetched = new Set(['conv-1', 'conv-2']);
    const result = applyPendingDeltas(fetched, new Map([
      ['conv-2', 'remove'],
      ['conv-3', 'add'],
    ]));
    expect(result).toEqual(new Set(['conv-1', 'conv-3']));
  });

  it('should not mutate the fetched input set', () => {
    const fetched = new Set(['conv-1']);
    applyPendingDeltas(fetched, new Map([['conv-2', 'add']]));
    expect(fetched).toEqual(new Set(['conv-1']));
  });
});
