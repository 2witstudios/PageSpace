import { describe, it, expect } from 'vitest';
import { applyAddStream } from '../applyAddStream';
import { applySetStreamParts } from '../applySetStreamParts';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: true,
};

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('applySetStreamParts', () => {
  it('given an existing stream and a fresh seq, should replace parts wholesale (not merge)', () => {
    let streams = applyAddStream(new Map(), { ...BASE_STREAM, parts: [text('a')] });
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('a'), text('b')], seq: 1 });
    expect(streams.get('msg-1')?.parts).toEqual([text('a'), text('b')]);
  });

  it('given the replacement, should stamp the entry lastSeq with the incoming seq', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('x')], seq: 3 });
    expect(streams.get('msg-1')?.lastSeq).toBe(3);
  });

  it('given a seq no greater than the current lastSeq, should drop the write as stale (no-op)', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('newer')], seq: 5 });
    const beforeStale = streams;
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('stale')], seq: 4 });
    expect(streams).toBe(beforeStale);
    expect(streams.get('msg-1')?.parts).toEqual([text('newer')]);
  });

  it('given a seq equal to the current lastSeq, should also drop it as stale', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('first')], seq: 1 });
    const beforeDupe = streams;
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('dup')], seq: 1 });
    expect(streams).toBe(beforeDupe);
  });

  it('given an unknown messageId, should no-op and return the same reference', () => {
    const streams = applyAddStream(new Map(), BASE_STREAM);
    const result = applySetStreamParts(streams, { messageId: 'unknown', parts: [text('x')], seq: 1 });
    expect(result).toBe(streams);
  });

  it('given a stream with no prior lastSeq, should accept seq 0 (treated as newer than unset)', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('first')], seq: 0 });
    expect(streams.get('msg-1')?.parts).toEqual([text('first')]);
    expect(streams.get('msg-1')?.lastSeq).toBe(0);
  });

  it('given a later replacement, should not affect other tracked streams (channel grouping preserved)', () => {
    let streams = applyAddStream(new Map(), BASE_STREAM);
    streams = applyAddStream(streams, { ...BASE_STREAM, messageId: 'msg-2', pageId: 'page-b' });
    const other = streams.get('msg-2');
    streams = applySetStreamParts(streams, { messageId: 'msg-1', parts: [text('x')], seq: 1 });
    expect(streams.get('msg-2')).toBe(other);
  });
});
