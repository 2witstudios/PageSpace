import { describe, it, expect } from 'vitest';
import { selectMessagesAreaMode } from '../selectMessagesAreaMode';

describe('selectMessagesAreaMode', () => {
  it('given loading with zero messages and zero streams, should show the skeleton', () => {
    expect(selectMessagesAreaMode({ isLoading: true, messageCount: 0, streamCount: 0 })).toBe('skeleton');
  });

  // The bug this replaces: ChatMessagesArea swapped the live list for a skeleton on
  // every `isLoading` tick even when messages were already on screen (e.g. a
  // background refetch), producing a list-to-skeleton flash mid-conversation.
  it('given loading with messages already on screen, should keep the content (no list-to-skeleton swap)', () => {
    expect(selectMessagesAreaMode({ isLoading: true, messageCount: 3, streamCount: 0 })).toBe('content');
  });

  it('given loading with no messages but a live stream already rendering, should keep the content', () => {
    expect(selectMessagesAreaMode({ isLoading: true, messageCount: 0, streamCount: 1 })).toBe('content');
  });

  it('given not loading, should show content regardless of message count', () => {
    expect(selectMessagesAreaMode({ isLoading: false, messageCount: 0, streamCount: 0 })).toBe('content');
  });

  it('given not loading with messages, should show content', () => {
    expect(selectMessagesAreaMode({ isLoading: false, messageCount: 5, streamCount: 0 })).toBe('content');
  });
});
