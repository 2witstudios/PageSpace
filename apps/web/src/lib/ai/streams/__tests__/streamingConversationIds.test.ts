import { describe, it, expect } from 'vitest';
import {
  parseStreamingConversationIds,
  addStreamingConversation,
  removeStreamingConversation,
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
