import { describe, it, expect } from 'vitest';
import { applyAddStream } from '../applyAddStream';
import type { PendingStreamsMap } from '../applyAddStream';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: false,
};

describe('applyAddStream', () => {
  it('given a new stream, should add it with empty parts and no lastSeq set', () => {
    const result = applyAddStream(new Map(), BASE_STREAM);
    expect(result.get('msg-1')).toEqual({ ...BASE_STREAM, parts: [] });
  });

  it('given initial parts, should seed the stream with them', () => {
    const result = applyAddStream(new Map(), { ...BASE_STREAM, parts: [{ type: 'text', text: 'restored' }] });
    expect(result.get('msg-1')?.parts).toEqual([{ type: 'text', text: 'restored' }]);
  });

  it('given a messageId already present, should no-op and return the same Map reference', () => {
    const initial: PendingStreamsMap = new Map([['msg-1', { ...BASE_STREAM, parts: [{ type: 'text', text: 'existing' }] }]]);
    const result = applyAddStream(initial, { ...BASE_STREAM, parts: [{ type: 'text', text: 'ignored' }] });
    expect(result).toBe(initial);
    expect(result.get('msg-1')?.parts).toEqual([{ type: 'text', text: 'existing' }]);
  });

  it('given other streams tracked, should not touch them', () => {
    const initial: PendingStreamsMap = new Map([['other', { ...BASE_STREAM, messageId: 'other', parts: [] }]]);
    const result = applyAddStream(initial, BASE_STREAM);
    expect(result.get('other')).toBe(initial.get('other'));
  });
});
