import { describe, it, expect, vi } from 'vitest';
import {
  createTerminalSessionMap,
  appendScrollback,
  broadcastOutput,
  broadcastClosed,
  MAX_SCROLLBACK_BYTES,
  type TerminalSession,
  type TerminalViewer,
} from '../terminal-session-map';

function fakeViewer(userId = 'user1'): TerminalViewer {
  return { userId, emitOutput: vi.fn(), emitClosed: vi.fn(), emitError: vi.fn() };
}

function fakeSession(sessionKey = 'key1', sandboxId = 'sbx1'): TerminalSession {
  return {
    command: { write: vi.fn(), kill: vi.fn(), resize: vi.fn(), setViewerAttached: vi.fn(), isQuiesced: () => false },
    sandboxId,
    sessionKey,
    lastViewerUserId: 'user1',
    releaseSlot: vi.fn(),
    viewers: new Map(),
    scrollback: [],
    scrollbackBytes: 0,
    hasOutput: false,
    resumedAtCreate: false,
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

  describe('addBinding', () => {
    it('given addBinding with a new socketId, getBySocket returns session for the new socket', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.addBinding('key1', 'sock2');
      expect(map.getBySocket('sock2')).toBe(session);
    });

    it('given addBinding, the FIRST socket keeps resolving too — joining never steals the incumbent binding (#2093)', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.addBinding('key1', 'sock2');
      expect(map.getBySocket('sock1')).toBe(session);
    });

    it('given addBinding, getByKey still returns the same session', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.addBinding('key1', 'sock2');
      expect(map.getByKey('key1')).toBe(session);
    });

    it('given two bindings and detach of one, the other still resolves', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.addBinding('key1', 'sock2');
      map.detach('sock1');
      expect(map.getBySocket('sock1')).toBeUndefined();
      expect(map.getBySocket('sock2')).toBe(session);
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

    it('given TWO bindings for one key, deleteByKey clears BOTH — a dangling survivor would resolve a detached viewer to a future session reusing the key (#2093)', () => {
      const map = createTerminalSessionMap();
      const session = fakeSession();
      map.setNew('key1', 'sock1', session);
      map.addBinding('key1', 'sock2');
      map.deleteByKey('key1');
      expect(map.getBySocket('sock1')).toBeUndefined();
      expect(map.getBySocket('sock2')).toBeUndefined();
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

describe('cold-create serialization (trackCreate / pendingCreate)', () => {
  it('given no create in flight, pendingCreate should report nothing', () => {
    const map = createTerminalSessionMap();
    expect(map.pendingCreate('k1')).toBeUndefined();
  });

  it('given a tracked create, pendingCreate should hand it back so a concurrent connect can join it', () => {
    const map = createTerminalSessionMap();
    const create = new Promise<void>(() => {}); // never settles during this test
    map.trackCreate('k1', create);

    expect(map.pendingCreate('k1')).toBe(create);
    // Claims are per-key — an unrelated terminal is never blocked by this one.
    expect(map.pendingCreate('k2')).toBeUndefined();
  });

  it('given the tracked create RESOLVES, should drop the claim so the key is connectable again', async () => {
    const map = createTerminalSessionMap();
    let finish!: () => void;
    map.trackCreate('k1', new Promise<void>((resolve) => { finish = resolve; }));
    expect(map.pendingCreate('k1')).toBeDefined();

    finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(map.pendingCreate('k1')).toBeUndefined();
  });

  it('given the tracked create REJECTS, should still drop the claim (a failed create must not wedge the key forever)', async () => {
    const map = createTerminalSessionMap();
    let fail!: (e: Error) => void;
    map.trackCreate('k1', new Promise<void>((_, reject) => { fail = reject; }));

    fail(new Error('provision failed'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(map.pendingCreate('k1')).toBeUndefined();
  });

  it('given a SECOND create claims the key while the first is still settling, should not let the first revoke the second\'s claim', async () => {
    const map = createTerminalSessionMap();
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    map.trackCreate('k1', first);

    // A later create takes the key over (the first failed and its retry queued).
    const second = new Promise<void>(() => {});
    map.trackCreate('k1', second);

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();

    // The stale first create's settle must not clear the SECOND's claim, or a
    // third connect would race the create that is genuinely still in flight.
    expect(map.pendingCreate('k1')).toBe(second);
  });
});

describe('broadcastOutput / broadcastClosed', () => {
  it('given N viewers, broadcastOutput fans the chunk out to every one of them', () => {
    const session = fakeSession();
    const a = fakeViewer('user1');
    const b = fakeViewer('user2');
    session.viewers.set('sockA conn-a', a);
    session.viewers.set('sockB conn-b', b);

    broadcastOutput(session, 'hello');

    expect(a.emitOutput).toHaveBeenCalledWith('hello');
    expect(b.emitOutput).toHaveBeenCalledWith('hello');
  });

  it('given N viewers, broadcastClosed fans the exit out to every one of them', () => {
    const session = fakeSession();
    const a = fakeViewer('user1');
    const b = fakeViewer('user2');
    session.viewers.set('sockA conn-a', a);
    session.viewers.set('sockB conn-b', b);

    broadcastClosed(session, 0);

    expect(a.emitClosed).toHaveBeenCalledWith(0);
    expect(b.emitClosed).toHaveBeenCalledWith(0);
  });

  it('given zero viewers, broadcasting is a no-op — a detached session emits to nobody', () => {
    const session = fakeSession();
    expect(() => {
      broadcastOutput(session, 'into the void');
      broadcastClosed(session, 1);
    }).not.toThrow();
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

describe('appendScrollback — hasOutput', () => {
  it('given a chunk BIGGER than the whole scrollback cap, should still record that the PTY has spoken', () => {
    const session = fakeSession();

    // The chunk is pushed, then trimmed straight back off: the buffer ends up
    // EMPTY for a session that has just produced 64KB+ of output.
    appendScrollback(session, 'x'.repeat(MAX_SCROLLBACK_BYTES + 1));

    expect({
      given: 'one output chunk larger than MAX_SCROLLBACK_BYTES',
      should:
        'leave hasOutput true even though the trim emptied the buffer — a client that reads an empty scrollback as "still booting, safe to type" would otherwise type a starting prompt into an agent that has been screaming output',
      actual: { scrollback: session.scrollback.length, hasOutput: session.hasOutput },
      expected: { scrollback: 0, hasOutput: true },
    }).toEqual({
      given: 'one output chunk larger than MAX_SCROLLBACK_BYTES',
      should:
        'leave hasOutput true even though the trim emptied the buffer — a client that reads an empty scrollback as "still booting, safe to type" would otherwise type a starting prompt into an agent that has been screaming output',
      actual: { scrollback: 0, hasOutput: true },
      expected: { scrollback: 0, hasOutput: true },
    });
  });

  it('given no output at all, should report hasOutput false', () => {
    const session = fakeSession();

    expect(session.hasOutput).toBe(false);
  });
});
