import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamMulticastRegistry } from '../stream-multicast-registry';

describe('StreamMulticastRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('register / getMeta', () => {
    it('stores stream metadata accessible via getMeta', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      expect(registry.getMeta('msg-1')).toEqual({ pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });
    });

    it('returns undefined for unknown messageId', () => {
      const registry = new StreamMulticastRegistry();
      expect(registry.getMeta('unknown')).toBeUndefined();
    });
  });

  describe('push', () => {
    it('given a registered stream with subscribers, should push text chunks to all active subscribers', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const received1: string[] = [];
      const received2: string[] = [];
      registry.subscribe('msg-1', (text) => received1.push(text), () => {});
      registry.subscribe('msg-1', (text) => received2.push(text), () => {});

      registry.push('msg-1', 'hello');
      registry.push('msg-1', ' world');

      expect(received1).toEqual(['hello', ' world']);
      expect(received2).toEqual(['hello', ' world']);
    });

    it('silently ignores push for unknown messageId', () => {
      const registry = new StreamMulticastRegistry();
      expect(() => registry.push('unknown', 'chunk')).not.toThrow();
    });
  });

  describe('subscribe', () => {
    it('given a late-joining subscriber, should replay all buffered chunks before delivering live ones', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      registry.push('msg-1', 'chunk1');
      registry.push('msg-1', 'chunk2');

      const received: string[] = [];
      registry.subscribe('msg-1', (text) => received.push(text), () => {});

      expect(received).toEqual(['chunk1', 'chunk2']);
    });

    it('given buffered and live chunks, should deliver them in order to a late subscriber', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      registry.push('msg-1', 'chunk1');
      registry.push('msg-1', 'chunk2');

      const received: string[] = [];
      registry.subscribe('msg-1', (text) => received.push(text), () => {});

      registry.push('msg-1', 'chunk3');

      expect(received).toEqual(['chunk1', 'chunk2', 'chunk3']);
    });

    it('given a finished stream, should return null', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });
      registry.finish('msg-1');

      const result = registry.subscribe('msg-1', () => {}, () => {});
      expect(result).toBeNull();
    });

    it('given an unknown messageId, should return null', () => {
      const registry = new StreamMulticastRegistry();
      const result = registry.subscribe('unknown', () => {}, () => {});
      expect(result).toBeNull();
    });

    it('returns an unsubscribe function for an active stream', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const unsubscribe = registry.subscribe('msg-1', () => {}, () => {});
      expect(typeof unsubscribe).toBe('function');
    });
  });

  describe('unsubscribe', () => {
    it('given a subscriber that unsubscribes, should stop receiving chunks without affecting other subscribers', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const received1: string[] = [];
      const received2: string[] = [];

      const unsubscribe1 = registry.subscribe('msg-1', (text) => received1.push(text), () => {});
      registry.subscribe('msg-1', (text) => received2.push(text), () => {});

      registry.push('msg-1', 'chunk1');
      expect(unsubscribe1).not.toBeNull();
      (unsubscribe1 as () => void)();
      registry.push('msg-1', 'chunk2');

      expect(received1).toEqual(['chunk1']);
      expect(received2).toEqual(['chunk1', 'chunk2']);
    });

    it('given an unsubscribed listener, should not call its onComplete when stream finishes', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completed1: boolean[] = [];
      const completed2: boolean[] = [];

      const unsubscribe1 = registry.subscribe('msg-1', () => {}, (aborted) => completed1.push(aborted));
      registry.subscribe('msg-1', () => {}, (aborted) => completed2.push(aborted));

      expect(unsubscribe1).not.toBeNull();
      (unsubscribe1 as () => void)();
      registry.finish('msg-1');

      expect(completed1).toEqual([]);
      expect(completed2).toEqual([false]);
    });
  });

  describe('finish', () => {
    it('given a finished stream, should call complete callbacks with aborted=false by default', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const abortedValues: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => abortedValues.push(aborted));

      registry.finish('msg-1');
      expect(abortedValues).toEqual([false]);
    });

    it('given a finished stream with aborted=true, should call complete callbacks with the correct aborted status', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const abortedValues: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => abortedValues.push(aborted));

      registry.finish('msg-1', true);
      expect(abortedValues).toEqual([true]);
    });

    it('removes the stream entry after finishing so getMeta returns undefined', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      registry.finish('msg-1');

      expect(registry.getMeta('msg-1')).toBeUndefined();
    });

    it('silently ignores finish for unknown messageId', () => {
      const registry = new StreamMulticastRegistry();
      expect(() => registry.finish('unknown')).not.toThrow();
    });

    it('silently ignores a second finish call', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completed: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => completed.push(aborted));

      registry.finish('msg-1');
      registry.finish('msg-1');

      expect(completed).toEqual([false]);
    });
  });

  describe('auto-cleanup', () => {
    it('given a stream still open after 10 minutes, should auto-cleanup to prevent memory leaks', () => {
      vi.useFakeTimers();
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completedValues: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => completedValues.push(aborted));

      expect(registry.getMeta('msg-1')).toBeDefined();

      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(registry.getMeta('msg-1')).toBeUndefined();
      expect(completedValues).toEqual([true]);
    });

    it('given a stream that finishes before 10 minutes, should not fire the auto-cleanup timer', () => {
      vi.useFakeTimers();
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completedValues: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => completedValues.push(aborted));

      registry.finish('msg-1', false);

      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(completedValues).toEqual([false]);
    });

    it('given register is called with an existing messageId that has subscribers, should notify those subscribers with aborted=true', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completed: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => completed.push(aborted));

      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      expect(completed).toEqual([true]);
    });

    it('given register is called twice for the same messageId, should call onComplete only once after 10 minutes', () => {
      vi.useFakeTimers();
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completed: boolean[] = [];
      registry.subscribe('msg-1', () => {}, (aborted) => completed.push(aborted));

      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(completed).toHaveLength(1);
    });
  });

  describe('resilience', () => {
    it('given a subscriber whose onChunk throws, should not interrupt fanout to remaining subscribers', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const received: string[] = [];
      registry.subscribe('msg-1', () => { throw new Error('bad subscriber'); }, () => {});
      registry.subscribe('msg-1', (text) => received.push(text), () => {});

      expect(() => registry.push('msg-1', 'chunk1')).not.toThrow();
      expect(received).toEqual(['chunk1']);
    });

    it('given a subscriber whose onComplete throws, should still remove the entry and notify remaining subscribers', () => {
      const registry = new StreamMulticastRegistry();
      registry.register('msg-1', { pageId: 'page-1', userId: 'user-1', displayName: 'Test User', conversationId: 'conv-1', tabId: 'tab-1' });

      const completed: boolean[] = [];
      registry.subscribe('msg-1', () => {}, () => { throw new Error('bad subscriber'); });
      registry.subscribe('msg-1', () => {}, (aborted) => completed.push(aborted));

      expect(() => registry.finish('msg-1')).not.toThrow();
      expect(registry.getMeta('msg-1')).toBeUndefined();
      expect(completed).toEqual([false]);
    });
  });
});
