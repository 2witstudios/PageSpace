import { describe, it, expect, beforeEach } from 'vitest';
import { usePendingStreamsStore } from '../usePendingStreamsStore';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: false,
};

const text = (text: string) => ({ type: 'text' as const, text });

describe('usePendingStreamsStore', () => {
  beforeEach(() => {
    usePendingStreamsStore.setState({ streams: new Map() });
  });

  describe('initial state', () => {
    it('given store is created, should have no streams for any page', () => {
      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      expect(getRemotePageStreams('page-a')).toEqual([]);
    });
  });

  describe('addStream', () => {
    it('given a new stream, should add it with empty parts', () => {
      const { addStream } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream).toEqual({ ...BASE_STREAM, parts: [] });
    });

    it('given two streams for the same page, should store both', () => {
      const { addStream } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      expect(getRemotePageStreams('page-a')).toHaveLength(2);
    });

    it('given a stream with messageId X already present, should preserve existing parts on duplicate addStream', () => {
      const { addStream, appendPart } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      appendPart('msg-1', text('partial-text'));
      addStream(BASE_STREAM);

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream.parts).toEqual([text('partial-text')]);
    });

    it('given a duplicate addStream with different metadata, should keep the existing entry unchanged', () => {
      const { addStream, appendPart } = usePendingStreamsStore.getState();
      addStream({ ...BASE_STREAM, isOwn: false });
      appendPart('msg-1', text('hello'));
      addStream({ ...BASE_STREAM, isOwn: true, conversationId: 'conv-other' });

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream.parts).toEqual([text('hello')]);
      expect(stream.isOwn).toBe(false);
      expect(stream.conversationId).toBe('conv-1');
    });
  });

  describe('appendPart', () => {
    it('given two consecutive text-deltas, should merge them positionally into one text part', () => {
      const { addStream, appendPart } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      appendPart('msg-1', text('hello'));
      appendPart('msg-1', text(' world'));

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream.parts).toEqual([text('hello world')]);
    });

    it('given a tool part with new toolCallId then output for the same id, should replace the in-place entry rather than duplicate', () => {
      const { addStream, appendPart } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      const inputPart = {
        type: 'tool-list_pages' as const,
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'input-available' as const,
        input: { driveId: 'd1' },
      };
      const outputPart = { ...inputPart, state: 'output-available' as const, output: { pages: [] } };
      appendPart('msg-1', inputPart);
      appendPart('msg-1', outputPart);

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream.parts).toEqual([outputPart]);
    });

    it('given unknown messageId, should not throw and should leave state untouched', () => {
      const { addStream, appendPart, getRemotePageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      const before = getRemotePageStreams('page-a');
      expect(() => appendPart('unknown', text('lost'))).not.toThrow();
      expect(usePendingStreamsStore.getState().getRemotePageStreams('page-a')).toEqual(before);
    });
  });

  describe('removeStream', () => {
    it('given an existing stream, should remove it', () => {
      const { addStream, removeStream } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      removeStream('msg-1');

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      expect(getRemotePageStreams('page-a')).toHaveLength(0);
    });

    it('given unknown messageId, should not throw', () => {
      const { removeStream } = usePendingStreamsStore.getState();
      expect(() => removeStream('unknown')).not.toThrow();
    });
  });

  describe('clearPageStreams', () => {
    it("given streams for a page, should remove only that page's streams", () => {
      const { addStream, clearPageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });
      addStream({ ...BASE_STREAM, messageId: 'msg-3', pageId: 'page-b' });

      clearPageStreams('page-a');

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      expect(getRemotePageStreams('page-a')).toHaveLength(0);
      expect(getRemotePageStreams('page-b')).toHaveLength(1);
    });

    it('given no streams for the page, should not throw', () => {
      const { clearPageStreams } = usePendingStreamsStore.getState();
      expect(() => clearPageStreams('page-missing')).not.toThrow();
    });
  });

  describe('getRemotePageStreams', () => {
    it("given streams for multiple pages, should return only the requested page's streams", () => {
      const { addStream, getRemotePageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });
      addStream({ ...BASE_STREAM, messageId: 'msg-3', pageId: 'page-b' });

      const streams = getRemotePageStreams('page-a');
      expect(streams).toHaveLength(2);
      expect(streams.every((s) => s.pageId === 'page-a')).toBe(true);
    });

    it('given no streams for the page, should return empty array', () => {
      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      expect(getRemotePageStreams('page-empty')).toEqual([]);
    });

    it('given appended parts, should reflect accumulated parts in returned stream', () => {
      const { addStream, appendPart, getRemotePageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      appendPart('msg-1', text('chunk-a'));
      appendPart('msg-1', text('chunk-b'));

      const [stream] = getRemotePageStreams('page-a');
      expect(stream.parts).toEqual([text('chunk-achunk-b')]);
    });
  });

  describe('getOwnStreams', () => {
    it('given a stream with isOwn true, should include it', () => {
      const { addStream, getOwnStreams } = usePendingStreamsStore.getState();
      addStream({ ...BASE_STREAM, isOwn: true });

      expect(getOwnStreams('page-a')).toHaveLength(1);
    });

    it('given a stream with isOwn false, should exclude it', () => {
      const { addStream, getOwnStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);

      expect(getOwnStreams('page-a')).toHaveLength(0);
    });

    it('given mixed own and remote streams, should return only own streams for the channel', () => {
      const { addStream, getOwnStreams } = usePendingStreamsStore.getState();
      addStream({ ...BASE_STREAM, messageId: 'msg-own', isOwn: true });
      addStream({ ...BASE_STREAM, messageId: 'msg-remote', isOwn: false });
      addStream({ ...BASE_STREAM, messageId: 'msg-other-page', pageId: 'page-b', isOwn: true });

      const streams = getOwnStreams('page-a');
      expect(streams).toHaveLength(1);
      expect(streams[0].messageId).toBe('msg-own');
    });

    it('given no streams for the channel, should return empty array', () => {
      const { getOwnStreams } = usePendingStreamsStore.getState();
      expect(getOwnStreams('page-empty')).toEqual([]);
    });
  });
});
