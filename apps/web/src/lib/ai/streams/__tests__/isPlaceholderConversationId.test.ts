import { describe, it, expect } from 'vitest';
import { isPlaceholderConversationId } from '../isPlaceholderConversationId';

describe('isPlaceholderConversationId', () => {
  it('given the channel-scoped default, should be true', () => {
    expect(isPlaceholderConversationId('page-123-default', 'page-123')).toBe(true);
  });

  it('given a real conversation id (not the placeholder), should be false', () => {
    expect(isPlaceholderConversationId('conv-abc', 'page-123')).toBe(false);
  });

  it('given null, should be false', () => {
    expect(isPlaceholderConversationId(null, 'page-123')).toBe(false);
  });

  it('given undefined, should be false', () => {
    expect(isPlaceholderConversationId(undefined, 'page-123')).toBe(false);
  });

  it('given a placeholder for a different channel, should be false', () => {
    expect(isPlaceholderConversationId('page-other-default', 'page-123')).toBe(false);
  });
});
