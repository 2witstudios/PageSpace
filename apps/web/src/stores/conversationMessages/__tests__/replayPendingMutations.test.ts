import { describe, it, expect } from 'vitest';
import { replayPendingMutations } from '../replayPendingMutations';
import type { PendingMutation } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string, text = ''): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('replayPendingMutations', () => {
  it('given no pending mutations, should return the messages unchanged (same reference)', () => {
    const messages = [msg('m1')];
    const result = replayPendingMutations(messages, []);
    expect(result).toBe(messages);
  });

  it('given a remoteMessage mutation for an id not in the base, should append it', () => {
    const result = replayPendingMutations([msg('m0')], [{ type: 'remoteMessage', message: msg('live-1') }]);
    expect(result).toEqual([msg('m0'), msg('live-1')]);
  });

  it('given a remoteMessage mutation for an id already present in the base, should not duplicate it', () => {
    const result = replayPendingMutations(
      [msg('m0'), msg('shared-1')],
      [{ type: 'remoteMessage', message: msg('shared-1') }],
    );
    expect(result).toEqual([msg('m0'), msg('shared-1')]);
  });

  it('given a confirmedMessage mutation for an id not in the base, should append it', () => {
    const result = replayPendingMutations([msg('m0')], [{ type: 'confirmedMessage', message: msg('live-1') }]);
    expect(result).toEqual([msg('m0'), msg('live-1')]);
  });

  it('given a confirmedMessage mutation for an id already present in the base with STALER content, should REPLACE it in place — not skip it like remoteMessage does', () => {
    const result = replayPendingMutations(
      [msg('m0'), msg('shared-1', 'stale-partial')],
      [{ type: 'confirmedMessage', message: msg('shared-1', 'full-confirmed') }],
    );
    expect(result).toEqual([msg('m0'), msg('shared-1', 'full-confirmed')]);
  });

  it('given an edit mutation for an id present in the base, should apply the edit', () => {
    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    const result = replayPendingMutations(
      [msg('m1', 'original')],
      [{ type: 'edit', payload: { messageId: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt } }],
    );
    expect(result[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt });
  });

  it('given an edit mutation for an id not present in the base, should no-op for that mutation', () => {
    const result = replayPendingMutations(
      [msg('m1', 'original')],
      [{ type: 'edit', payload: { messageId: 'missing', parts: [], editedAt: new Date() } }],
    );
    expect(result).toEqual([msg('m1', 'original')]);
  });

  it('given an askUserAnswer mutation for a message present in the base, should patch its ask_user part to output-available', () => {
    const askUserMessage: UIMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'tool-ask_user', toolCallId: 'tc1', state: 'input-available', input: { questions: [] } } as UIMessage['parts'][number]],
    };
    const result = replayPendingMutations(
      [askUserMessage],
      [{
        type: 'askUserAnswer',
        payload: { messageId: 'm1', toolCallId: 'tc1', output: { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] } },
      }] as PendingMutation[],
    );
    expect(result[0].parts[0]).toMatchObject({ state: 'output-available' });
  });

  it('given an askUserAnswer mutation for a message not present in the base, should no-op for that mutation', () => {
    const result = replayPendingMutations(
      [msg('m1')],
      [{
        type: 'askUserAnswer',
        payload: { messageId: 'missing', toolCallId: 'tc1', output: { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] } },
      }] as PendingMutation[],
    );
    expect(result).toEqual([msg('m1')]);
  });

  it('given a delete mutation for an id present in the base, should remove it', () => {
    const result = replayPendingMutations(
      [msg('m1'), msg('m2')],
      [{ type: 'delete', messageId: 'm1' }],
    );
    expect(result).toEqual([msg('m2')]);
  });

  it('given a delete mutation for an id not present in the base, should no-op for that mutation', () => {
    const result = replayPendingMutations([msg('m1')], [{ type: 'delete', messageId: 'missing' }]);
    expect(result).toEqual([msg('m1')]);
  });

  it('given multiple mutations, should apply them in order', () => {
    const result = replayPendingMutations(
      [msg('m1', 'original')],
      [
        { type: 'remoteMessage', message: msg('m2', 'new') },
        { type: 'edit', payload: { messageId: 'm1', parts: [{ type: 'text', text: 'edited' }], editedAt: new Date() } },
        { type: 'delete', messageId: 'm2' },
      ] as PendingMutation[],
    );
    expect(result.map((m) => m.id)).toEqual(['m1']);
    expect(result[0].parts).toEqual([{ type: 'text', text: 'edited' }]);
  });

  it('given the replay, should not mutate the input messages array', () => {
    const messages = [msg('m1')];
    replayPendingMutations(messages, [{ type: 'remoteMessage', message: msg('m2') }]);
    expect(messages).toEqual([msg('m1')]);
  });
});
