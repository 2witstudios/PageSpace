import { describe, it, expect } from 'vitest';
import { applyAddStream } from '../applyAddStream';
import { applyAppendPart } from '../applyAppendPart';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: false,
};

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('applyAppendPart', () => {
  it('given two consecutive text parts, should merge them positionally', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applyAppendPart(streams, { messageId: 'msg-1', part: text('hello') });
    streams = applyAppendPart(streams, { messageId: 'msg-1', part: text(' world') });
    expect(streams.get('msg-1')?.parts).toEqual([text('hello world')]);
  });

  it('given an unknown messageId, should no-op and return the same reference', () => {
    const streams = applyAddStream(new Map(), BASE_STREAM);
    const result = applyAppendPart(streams, { messageId: 'unknown', part: text('lost') });
    expect(result).toBe(streams);
  });

  it('given the append, should not mutate lastSeq', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applyAppendPart(streams, { messageId: 'msg-1', part: text('hi') });
    expect(streams.get('msg-1')?.lastSeq).toBeUndefined();
  });
});
