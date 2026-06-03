import { describe, it, expect } from 'vitest';
import { resolveActiveAssistantMessageId } from '../resolveActiveAssistantMessageId';

describe('resolveActiveAssistantMessageId', () => {
  it('given an own/bootstrapped stream messageId, should return it (takes precedence)', () => {
    expect(
      resolveActiveAssistantMessageId({
        ownStreamMessageId: 'own-msg',
        isStreaming: true,
        lastAssistantMessageId: 'last-msg',
      }),
    ).toBe('own-msg');
  });

  it('given own stream present but not streaming, should still return the own messageId', () => {
    expect(
      resolveActiveAssistantMessageId({
        ownStreamMessageId: 'own-msg',
        isStreaming: false,
        lastAssistantMessageId: undefined,
      }),
    ).toBe('own-msg');
  });

  it('given a live stream and no own stream, should return the last assistant messageId', () => {
    expect(
      resolveActiveAssistantMessageId({
        ownStreamMessageId: undefined,
        isStreaming: true,
        lastAssistantMessageId: 'last-msg',
      }),
    ).toBe('last-msg');
  });

  it('given submitted-before-first-chunk (streaming, no assistant id yet), should return undefined', () => {
    expect(
      resolveActiveAssistantMessageId({
        ownStreamMessageId: undefined,
        isStreaming: true,
        lastAssistantMessageId: null,
      }),
    ).toBeUndefined();
  });

  it('given idle (not streaming, no own stream), should return undefined', () => {
    expect(
      resolveActiveAssistantMessageId({
        ownStreamMessageId: undefined,
        isStreaming: false,
        lastAssistantMessageId: 'last-msg',
      }),
    ).toBeUndefined();
  });
});
