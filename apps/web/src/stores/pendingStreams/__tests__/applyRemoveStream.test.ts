import { describe, it, expect } from 'vitest';
import { applyAddStream } from '../applyAddStream';
import { applyRemoveStream } from '../applyRemoveStream';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: false,
};

describe('applyRemoveStream', () => {
  it('given an existing stream, should remove it', () => {
    const streams = applyAddStream(new Map(), BASE_STREAM);
    const result = applyRemoveStream(streams, 'msg-1');
    expect(result.has('msg-1')).toBe(false);
  });

  it('given an unknown messageId, should no-op and return the same reference', () => {
    const streams = applyAddStream(new Map(), BASE_STREAM);
    const result = applyRemoveStream(streams, 'unknown');
    expect(result).toBe(streams);
  });

  it('given other streams tracked, should not touch them', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applyAddStream(streams, { ...BASE_STREAM, messageId: 'msg-2' });
    const other = streams.get('msg-2');
    const result = applyRemoveStream(streams, 'msg-1');
    expect(result.get('msg-2')).toBe(other);
  });
});
