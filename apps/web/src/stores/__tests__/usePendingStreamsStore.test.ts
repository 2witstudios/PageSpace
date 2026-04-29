import { describe, it, expect, beforeEach } from 'vitest';
import { usePendingStreamsStore } from '../usePendingStreamsStore';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  isOwn: false,
};

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
    it('given a new stream, should add it with empty text', () => {
      const { addStream } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream).toEqual({ ...BASE_STREAM, text: '' });
    });

    it('given two streams for the same page, should store both', () => {
      const { addStream } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      expect(getRemotePageStreams('page-a')).toHaveLength(2);
    });
  });

  describe('appendText', () => {
    it('given an existing stream, should accumulate text chunks', () => {
      const { addStream, appendText } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      appendText('msg-1', 'hello');
      appendText('msg-1', ' world');

      const { getRemotePageStreams } = usePendingStreamsStore.getState();
      const [stream] = getRemotePageStreams('page-a');
      expect(stream.text).toBe('hello world');
    });

    it('given unknown messageId, should not throw', () => {
      const { appendText } = usePendingStreamsStore.getState();
      expect(() => appendText('unknown', 'text')).not.toThrow();
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

    it('given appended text, should reflect accumulated text in returned stream', () => {
      const { addStream, appendText, getRemotePageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      appendText('msg-1', 'chunk-a');
      appendText('msg-1', 'chunk-b');

      const [stream] = getRemotePageStreams('page-a');
      expect(stream.text).toBe('chunk-achunk-b');
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
      addStream(BASE_STREAM); // isOwn: false

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
