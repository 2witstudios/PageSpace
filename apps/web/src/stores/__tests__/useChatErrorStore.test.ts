import { describe, it, expect, beforeEach } from 'vitest';
import { useChatErrorStore } from '../useChatErrorStore';

describe('useChatErrorStore', () => {
  beforeEach(() => {
    useChatErrorStore.setState({ byConversationId: {} });
  });

  it('given no error was ever set, should return null for a conversation', () => {
    expect(useChatErrorStore.getState().getError('conv-1')).toBeNull();
  });

  it('given setError, should store the cause for that conversation', () => {
    const cause = { code: 'out_of_credits' as const, httpStatus: 402, message: 'balance too low', retryable: false };
    useChatErrorStore.getState().setError('conv-1', cause);
    expect(useChatErrorStore.getState().getError('conv-1')).toEqual(cause);
  });

  it('given a conversation switch, should NOT carry the previous conversation error (per-conversation keying, M10)', () => {
    const cause = { code: 'out_of_credits' as const, httpStatus: 402, message: 'balance too low', retryable: false };
    useChatErrorStore.getState().setError('conv-1', cause);
    expect(useChatErrorStore.getState().getError('conv-2')).toBeNull();
  });

  it('given clearError, should remove the cause for that conversation only', () => {
    const cause = { code: 'out_of_credits' as const, httpStatus: 402, message: 'balance too low', retryable: false };
    useChatErrorStore.getState().setError('conv-1', cause);
    useChatErrorStore.getState().setError('conv-2', cause);
    useChatErrorStore.getState().clearError('conv-1');
    expect(useChatErrorStore.getState().getError('conv-1')).toBeNull();
    expect(useChatErrorStore.getState().getError('conv-2')).toEqual(cause);
  });

  it('given clearError for a conversation with no error, should be a no-op', () => {
    expect(() => useChatErrorStore.getState().clearError('never-set')).not.toThrow();
    expect(useChatErrorStore.getState().getError('never-set')).toBeNull();
  });

  it('given setError overwrites a previous cause for the same conversation, should hold only the latest', () => {
    const first = { code: 'rate_limit' as const, httpStatus: 429, message: 'busy', retryable: true };
    const second = { code: 'out_of_credits' as const, httpStatus: 402, message: 'balance too low', retryable: false };
    useChatErrorStore.getState().setError('conv-1', first);
    useChatErrorStore.getState().setError('conv-1', second);
    expect(useChatErrorStore.getState().getError('conv-1')).toEqual(second);
  });
});
