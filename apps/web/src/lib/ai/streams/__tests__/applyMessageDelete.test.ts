import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { applyMessageDelete } from '../applyMessageDelete';

const makeTextMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('applyMessageDelete', () => {
  it('given a target messageId in the array, should return a new array with that message removed', () => {
    const messages: UIMessage[] = [
      makeTextMessage('m1', 'hello'),
      makeTextMessage('m2', 'world'),
      makeTextMessage('m3', 'goodbye'),
    ];

    const next = applyMessageDelete(messages, 'm2');

    expect(next).toEqual([makeTextMessage('m1', 'hello'), makeTextMessage('m3', 'goodbye')]);
  });

  it('given a messageId not present in the array, should return the input array reference unchanged', () => {
    const messages: UIMessage[] = [makeTextMessage('m1', 'hello')];

    const next = applyMessageDelete(messages, 'unknown');

    expect(next).toBe(messages);
  });

  it('given any input array, should not mutate the input — the original messages remain byte-for-byte equal after the call', () => {
    const messages: UIMessage[] = [
      makeTextMessage('m1', 'hello'),
      makeTextMessage('m2', 'world'),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    applyMessageDelete(messages, 'm2');

    expect(messages).toEqual(snapshot);
  });
});
