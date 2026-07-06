import { describe, it, expect, vi } from 'vitest';
import { createTerminalSessionMap, appendScrollback, MAX_SCROLLBACK_BYTES, type TerminalSession } from '../terminal-session-map';

function fakeSession(sessionKey = 'key1', sandboxId = 'sbx1'): TerminalSession {
  return {
    command: { write: vi.fn(), kill: vi.fn(), resize: vi.fn() },
    sandboxId,
    sessionKey,
    releaseSlot: vi.fn(),
    outputFn: vi.fn(),
    closedFn: vi.fn(),
    scrollback: [],
    scrollbackBytes: 0,
    reAuthInterval: undefined,
    idleTimer: undefined,
  };
}

describe('createTerminalSessionMap', () => {
  describe('getBySocket / setNew', () => {
    it('given setNew, getBySocket returns the session for that socket', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      expect(map.getBySocket('sock1')).toBe(session);
    });

    it('given an unknown socketId, getBySocket returns undefined', () => {
      const map = createTerminalSessionMap();
      expect(map.getBySocket('unknown')).toBeUndefined();
    });

    it('given setNew twice with same sessionKey but different sockets, getByKey returns the last set session', () => {
      const map = createTerminalSessionMap();
      const a = fakeSession('key1', 'sbx1');
      const b = fakeSession('key1', 'sbx2');
      map.setNew('key1', 'sock1', a);
      map.setNew('key1', 'sock2', b);
      expect(map.getByKey('key1')).toBe(b);
    });
  });

  describe('getByKey', () => {
    it('given setNew, getByKey returns the session for that sessionKey', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      expect(map.getByKey('key1')).toBe(session);
    });

    it('given an unknown sessionKey, getByKey returns undefined', () => {
      const map = createTerminalSessionMap();
      expect(map.getByKey('unknown')).toBeUndefined();
    });
  });

  describe('reattach', () => {
    it('given reattach with a new socketId, getBySocket returns session for the new socket', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.reattach('key1', 'sock2');
      expect(map.getBySocket('sock2')).toBe(session);
    });

    it('given reattach, getBySocket for the old socketId returns undefined', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.reattach('key1', 'sock2');
      expect(map.getBySocket('sock1')).toBeUndefined();
    });

    it('given reattach, getByKey still returns the same session', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.reattach('key1', 'sock2');
      expect(map.getByKey('key1')).toBe(session);
    });
  });

  describe('detach', () => {
    it('given detach, getBySocket returns undefined for that socket', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.detach('sock1');
      expect(map.getBySocket('sock1')).toBeUndefined();
    });

    it('given detach, getByKey still returns the session (shell survives)', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.detach('sock1');
      expect(map.getByKey('key1')).toBe(session);
    });

    it('given detach on unknown socketId, should be a no-op', () => {
      const map = createTerminalSessionMap();
      expect(() => map.detach('nope')).not.toThrow();
    });
  });

  describe('deleteByKey', () => {
    it('given deleteByKey, getByKey returns undefined', () => {
      const map = createTerminalSessionMap();
      map.setNew('key1', 'sock1', fakeSession());
      map.deleteByKey('key1');
      expect(map.getByKey('key1')).toBeUndefined();
    });

    it('given deleteByKey, getBySocket for the associated socket returns undefined', () => {
      const map = createTerminalSessionMap();
      map.setNew('key1', 'sock1', fakeSession());
      map.deleteByKey('key1');
      expect(map.getBySocket('sock1')).toBeUndefined();
    });

    it('given deleteByKey on unknown key, should be a no-op', () => {
      const map = createTerminalSessionMap();
      expect(() => map.deleteByKey('nope')).not.toThrow();
    });

    it('given two sessions, deleteByKey for one should not affect the other', () => {
      const map = createTerminalSessionMap();
      const a = fakeSession('key1', 'sbx1');
      const b = fakeSession('key2', 'sbx2');
      map.setNew('key1', 'sock1', a);
      map.setNew('key2', 'sock2', b);
      map.deleteByKey('key1');
      expect(map.getByKey('key2')).toBe(b);
      expect(map.getBySocket('sock2')).toBe(b);
    });
  });
});

describe('appendScrollback', () => {
  it('given small chunks, should accumulate them in order', () => {
    const session = { scrollback: [] as string[], scrollbackBytes: 0 };
    appendScrollback(session, 'hello ');
    appendScrollback(session, 'world');
    expect(session.scrollback).toEqual(['hello ', 'world']);
    expect(session.scrollbackBytes).toBe(Buffer.byteLength('hello world', 'utf8'));
  });

  it('given accumulated bytes over the cap, should drop the oldest chunks until back under the cap', () => {
    const session = { scrollback: [] as string[], scrollbackBytes: 0 };
    const chunk = 'x'.repeat(MAX_SCROLLBACK_BYTES / 2 + 1);
    appendScrollback(session, chunk);
    appendScrollback(session, chunk);
    appendScrollback(session, chunk);
    expect(session.scrollbackBytes).toBeLessThanOrEqual(MAX_SCROLLBACK_BYTES);
    expect(session.scrollback.length).toBe(1);
  });

  it('given multi-byte UTF-8 chunks, should track byte length, not char length', () => {
    const session = { scrollback: [] as string[], scrollbackBytes: 0 };
    const emoji = '🚀'; // 4 bytes in UTF-8, 2 UTF-16 code units
    appendScrollback(session, emoji);
    expect(session.scrollbackBytes).toBe(4);
  });
});
