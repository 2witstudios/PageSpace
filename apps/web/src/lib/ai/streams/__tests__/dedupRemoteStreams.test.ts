import { describe, it, expect } from 'vitest';
import { dedupRemoteStreams } from '../dedupRemoteStreams';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

const stream = (messageId: string): PendingStream => ({
  messageId,
  pageId: 'p',
  conversationId: 'c',
  triggeredBy: { userId: 'u', displayName: 'U' },
  parts: [],
  isOwn: false,
});

describe('dedupRemoteStreams', () => {
  it('given a stream whose messageId is already in messages, should drop it', () => {
    const streams = [stream('msg-1'), stream('msg-2')];
    const messages = [{ id: 'msg-1' }];

    expect(dedupRemoteStreams(streams, messages)).toEqual([stream('msg-2')]);
  });

  it('given streams with no overlap with messages, should return all streams unchanged', () => {
    const streams = [stream('msg-1'), stream('msg-2')];
    const messages = [{ id: 'msg-3' }];

    expect(dedupRemoteStreams(streams, messages)).toEqual(streams);
  });

  it('given an empty stream list, should return an empty array', () => {
    expect(dedupRemoteStreams([], [{ id: 'msg-1' }])).toEqual([]);
  });

  it('given empty messages, should return all streams unchanged', () => {
    const streams = [stream('msg-1')];
    expect(dedupRemoteStreams(streams, [])).toEqual(streams);
  });

  it('given a stream that overlaps and others that do not, should preserve order of the survivors', () => {
    const streams = [stream('msg-a'), stream('msg-b'), stream('msg-c')];
    const messages = [{ id: 'msg-b' }];

    const result = dedupRemoteStreams(streams, messages);
    expect(result.map((s) => s.messageId)).toEqual(['msg-a', 'msg-c']);
  });
});
