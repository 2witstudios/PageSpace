import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { applyMessageEdit, type MessageEditPayload } from '../applyMessageEdit';

type EditableMessage = UIMessage & { editedAt?: Date | null };

const makeTextMessage = (id: string, text: string, role: 'user' | 'assistant' = 'user'): EditableMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
});

describe('applyMessageEdit', () => {
  it('given a target messageId in the array, should return a new array with the target message parts replaced and editedAt set', () => {
    const messages: EditableMessage[] = [
      makeTextMessage('m1', 'hello'),
      makeTextMessage('m2', 'world'),
    ];
    const editedAt = new Date('2026-05-01T00:00:00.000Z');
    const payload: MessageEditPayload = {
      messageId: 'm2',
      parts: [{ type: 'text', text: 'updated' }],
      editedAt,
    };

    const next = applyMessageEdit(messages, payload);

    expect(next).toEqual([
      makeTextMessage('m1', 'hello'),
      { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'updated' }], editedAt },
    ]);
  });

  it('given a messageId not present in the array, should return the input array reference unchanged', () => {
    const messages: EditableMessage[] = [makeTextMessage('m1', 'hello')];
    const payload: MessageEditPayload = {
      messageId: 'unknown',
      parts: [{ type: 'text', text: 'updated' }],
      editedAt: new Date(),
    };

    const next = applyMessageEdit(messages, payload);

    expect(next).toBe(messages);
  });

  it('given any input array, should not mutate the input — the original messages remain byte-for-byte equal after the call', () => {
    const messages: EditableMessage[] = [
      makeTextMessage('m1', 'hello'),
      makeTextMessage('m2', 'world'),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    applyMessageEdit(messages, {
      messageId: 'm2',
      parts: [{ type: 'text', text: 'updated' }],
      editedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(messages).toEqual(snapshot);
  });
});
