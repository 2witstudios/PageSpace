import { describe, it, expect } from 'vitest';
import { resolveInputPosition, type InputPositionLatch } from '../resolveInputPosition';

const NO_LATCH: InputPositionLatch = { conversationId: null, docked: false };

describe('resolveInputPosition', () => {
  it('given a freshly loaded, truly empty conversation (New Chat), should return centered', () => {
    const { position } = resolveInputPosition({
      conversationId: 'new-chat-1',
      isLoading: false,
      hasMessages: false,
      hasRemoteStreams: false,
      latch: NO_LATCH,
    });
    expect(position).toBe('centered');
  });

  it('given a conversation with messages, should return docked and latch it', () => {
    const { position, latch } = resolveInputPosition({
      conversationId: 'conv-1',
      isLoading: false,
      hasMessages: true,
      hasRemoteStreams: false,
      latch: NO_LATCH,
    });
    expect(position).toBe('docked');
    expect(latch).toEqual({ conversationId: 'conv-1', docked: true });
  });

  it('given a conversation currently loading (identity known, messages not yet fetched), should return docked', () => {
    const { position } = resolveInputPosition({
      conversationId: 'conv-1',
      isLoading: true,
      hasMessages: false,
      hasRemoteStreams: false,
      latch: NO_LATCH,
    });
    expect(position).toBe('docked');
  });

  it('given a remote stream already live for this conversation, should return docked', () => {
    const { position } = resolveInputPosition({
      conversationId: 'conv-1',
      isLoading: false,
      hasMessages: false,
      hasRemoteStreams: true,
      latch: NO_LATCH,
    });
    expect(position).toBe('docked');
  });

  // The bug this replaces: mid-refetch, `hasMessages` can read false for one frame
  // while `isLoading` has also already settled false (a race between the two signals) —
  // without the latch that frame reads as "loaded and empty" and flashes centered for a
  // conversation that plainly has content, then flashes back to docked on the next frame.
  it('given the SAME conversationId previously latched docked, should stay docked even if this frame looks loaded-and-empty', () => {
    const latch: InputPositionLatch = { conversationId: 'conv-1', docked: true };
    const { position } = resolveInputPosition({
      conversationId: 'conv-1',
      isLoading: false,
      hasMessages: false,
      hasRemoteStreams: false,
      latch,
    });
    expect(position).toBe('docked');
  });

  it('given a DIFFERENT conversationId than the latch (switched to New Chat), should NOT carry over the old docked latch', () => {
    const latch: InputPositionLatch = { conversationId: 'conv-1', docked: true };
    const { position, latch: nextLatch } = resolveInputPosition({
      conversationId: 'new-chat-2',
      isLoading: false,
      hasMessages: false,
      hasRemoteStreams: false,
      latch,
    });
    expect(position).toBe('centered');
    expect(nextLatch).toEqual({ conversationId: 'new-chat-2', docked: false });
  });
});
