import { describe, it, expect, vi } from 'vitest';
import { createTerminalSessionMap, type TerminalSession } from '../terminal-session-map';

function fakeSession(sandboxId = 'sbx1'): TerminalSession {
  return {
    command: { write: vi.fn(), kill: vi.fn(), resize: vi.fn() },
    sandboxId,
  };
}

describe('createTerminalSessionMap', () => {
  it('given a new map, has() should return false for an unknown key', () => {
    const map = createTerminalSessionMap();
    expect(map.has('unknown')).toBe(false);
  });

  it('given set(id, session), get(id) should return that session', () => {
    const map = createTerminalSessionMap();
    const session = fakeSession();
    map.set('sock1', session);
    expect(map.get('sock1')).toBe(session);
  });

  it('given an unknown key, get() should return undefined', () => {
    const map = createTerminalSessionMap();
    expect(map.get('missing')).toBeUndefined();
  });

  it('given set then delete, has() should return false', () => {
    const map = createTerminalSessionMap();
    map.set('sock1', fakeSession());
    map.delete('sock1');
    expect(map.has('sock1')).toBe(false);
  });

  it('given set then delete, get() should return undefined', () => {
    const map = createTerminalSessionMap();
    map.set('sock1', fakeSession());
    map.delete('sock1');
    expect(map.get('sock1')).toBeUndefined();
  });

  it('given two sessions, deleting one should not affect the other', () => {
    const map = createTerminalSessionMap();
    const a = fakeSession('a');
    const b = fakeSession('b');
    map.set('sock1', a);
    map.set('sock2', b);
    map.delete('sock1');
    expect(map.get('sock2')).toBe(b);
  });

  it('given delete on a non-existent key, should be a no-op', () => {
    const map = createTerminalSessionMap();
    expect(() => map.delete('nope')).not.toThrow();
  });

  it('given set twice with same key, get() should return the latest session', () => {
    const map = createTerminalSessionMap();
    const a = fakeSession('a');
    const b = fakeSession('b');
    map.set('sock1', a);
    map.set('sock1', b);
    expect(map.get('sock1')).toBe(b);
  });
});
