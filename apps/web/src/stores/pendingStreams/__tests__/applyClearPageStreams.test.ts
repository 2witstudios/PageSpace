import { describe, it, expect } from 'vitest';
import { applyAddStream } from '../applyAddStream';
import { applyClearPageStreams } from '../applyClearPageStreams';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: false,
};

describe('applyClearPageStreams', () => {
  it("given streams for multiple pages, should remove only the requested page's streams", () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applyAddStream(streams, { ...BASE_STREAM, messageId: 'msg-2' });
    streams = applyAddStream(streams, { ...BASE_STREAM, messageId: 'msg-3', pageId: 'page-b' });

    const result = applyClearPageStreams(streams, 'page-a');
    expect(result.has('msg-1')).toBe(false);
    expect(result.has('msg-2')).toBe(false);
    expect(result.has('msg-3')).toBe(true);
  });

  it('given no streams for the page, should no-op and return the same reference', () => {
    const streams = applyAddStream(new Map(), BASE_STREAM);
    const result = applyClearPageStreams(streams, 'page-missing');
    expect(result).toBe(streams);
  });

  it('given an empty store, should no-op', () => {
    const streams = new Map();
    const result = applyClearPageStreams(streams, 'page-a');
    expect(result).toBe(streams);
  });
});
