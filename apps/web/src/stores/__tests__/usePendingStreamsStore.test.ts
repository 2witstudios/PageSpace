import { describe, it, expect, beforeEach } from 'vitest';
import { usePendingStreamsStore } from '../usePendingStreamsStore';

const BASE_STREAM = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
};

describe('usePendingStreamsStore', () => {
  beforeEach(() => {
    usePendingStreamsStore.setState({ streams: new Map() });
  });

  describe('initial state', () => {
    it('given store is created, should have no streams', () => {
      const { streams } = usePendingStreamsStore.getState();
      expect(streams.size).toBe(0);
    });
  });

  describe('addStream', () => {
    it('given a new stream, should add it with empty text', () => {
      const { addStream, streams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);

      const stream = usePendingStreamsStore.getState().streams.get('msg-1');
      expect(stream).toEqual({ ...BASE_STREAM, text: '' });
    });

    it('given two streams for different messages, should store both', () => {
      const { addStream } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });

      expect(usePendingStreamsStore.getState().streams.size).toBe(2);
    });
  });

  describe('appendText', () => {
    it('given an existing stream, should accumulate text chunks', () => {
      const { addStream, appendText } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      appendText('msg-1', 'hello');
      appendText('msg-1', ' world');

      const stream = usePendingStreamsStore.getState().streams.get('msg-1');
      expect(stream?.text).toBe('hello world');
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

      expect(usePendingStreamsStore.getState().streams.size).toBe(0);
    });

    it('given unknown messageId, should not throw', () => {
      const { removeStream } = usePendingStreamsStore.getState();
      expect(() => removeStream('unknown')).not.toThrow();
    });
  });

  describe('clearPageStreams', () => {
    it('given streams for a page, should remove only that page\'s streams', () => {
      const { addStream, clearPageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });
      addStream({ ...BASE_STREAM, messageId: 'msg-3', pageId: 'page-b' });

      clearPageStreams('page-a');

      const remaining = usePendingStreamsStore.getState().streams;
      expect(remaining.size).toBe(1);
      expect(remaining.has('msg-3')).toBe(true);
    });

    it('given no streams for the page, should not throw', () => {
      const { clearPageStreams } = usePendingStreamsStore.getState();
      expect(() => clearPageStreams('page-missing')).not.toThrow();
    });
  });

  describe('getRemotePageStreams', () => {
    it('given streams for multiple pages, should return only the requested page\'s streams', () => {
      const { addStream, getRemotePageStreams } = usePendingStreamsStore.getState();
      addStream(BASE_STREAM);
      addStream({ ...BASE_STREAM, messageId: 'msg-2' });
      addStream({ ...BASE_STREAM, messageId: 'msg-3', pageId: 'page-b' });

      const streams = getRemotePageStreams('page-a');
      expect(streams).toHaveLength(2);
      expect(streams.every(s => s.pageId === 'page-a')).toBe(true);
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
});
