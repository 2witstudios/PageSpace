import { describe, it, expect, vi } from 'vitest';
import { createAppLogSessionMap, broadcastLogLine, type AppLogSession } from '../app-log-session-map';

function makeSession(flyAppName: string): AppLogSession {
  return { flyAppName, unsubscribe: vi.fn(), viewers: new Map() };
}

describe('app-log-session-map', () => {
  it('getByApp / getBySocket return undefined for an unknown key', () => {
    const map = createAppLogSessionMap();
    expect(map.getByApp('pgs-app-x')).toBeUndefined();
    expect(map.getBySocket('socket-1:pgs-app-x')).toBeUndefined();
  });

  it('setNew registers a session findable by app id', () => {
    const map = createAppLogSessionMap();
    const session = makeSession('pgs-app-a');
    map.setNew(session);
    expect(map.getByApp('pgs-app-a')).toBe(session);
  });

  it('addViewer on a session that does not exist is a no-op', () => {
    const map = createAppLogSessionMap();
    map.addViewer('pgs-app-missing', 'socket-1:pgs-app-missing', { emitLine: vi.fn() });
    expect(map.getBySocket('socket-1:pgs-app-missing')).toBeUndefined();
  });

  it('addViewer registers the viewer and makes it reachable via getBySocket', () => {
    const map = createAppLogSessionMap();
    const session = makeSession('pgs-app-a');
    map.setNew(session);
    const viewer = { emitLine: vi.fn() };
    map.addViewer('pgs-app-a', 'socket-1:pgs-app-a', viewer);

    expect(session.viewers.get('socket-1:pgs-app-a')).toBe(viewer);
    expect(map.getBySocket('socket-1:pgs-app-a')).toBe(session);
  });

  it('removeViewer on an unknown viewerKey returns undefined and touches nothing', () => {
    const map = createAppLogSessionMap();
    expect(map.removeViewer('socket-1:pgs-app-a')).toBeUndefined();
  });

  it('removeViewer detaches the viewer and returns the session for idle-arming', () => {
    const map = createAppLogSessionMap();
    const session = makeSession('pgs-app-a');
    map.setNew(session);
    map.addViewer('pgs-app-a', 'socket-1:pgs-app-a', { emitLine: vi.fn() });

    const returned = map.removeViewer('socket-1:pgs-app-a');

    expect(returned).toBe(session);
    expect(session.viewers.size).toBe(0);
    // The socket->app pointer is gone too, so a second removeViewer for the
    // same key is a clean no-op rather than double-detaching.
    expect(map.removeViewer('socket-1:pgs-app-a')).toBeUndefined();
  });

  it('deleteByApp removes the session and every bySocket pointer that named it, leaving other apps untouched', () => {
    const map = createAppLogSessionMap();
    const sessionA = makeSession('pgs-app-a');
    const sessionB = makeSession('pgs-app-b');
    map.setNew(sessionA);
    map.setNew(sessionB);
    map.addViewer('pgs-app-a', 'socket-1:pgs-app-a', { emitLine: vi.fn() });
    map.addViewer('pgs-app-b', 'socket-1:pgs-app-b', { emitLine: vi.fn() });

    map.deleteByApp('pgs-app-a');

    expect(map.getByApp('pgs-app-a')).toBeUndefined();
    expect(map.getBySocket('socket-1:pgs-app-a')).toBeUndefined();
    // app-b's session and its socket pointer survive app-a's teardown.
    expect(map.getByApp('pgs-app-b')).toBe(sessionB);
    expect(map.getBySocket('socket-1:pgs-app-b')).toBe(sessionB);
  });
});

describe('broadcastLogLine', () => {
  it('fans one line out to every attached viewer with the session flyAppName stamped on', () => {
    const viewerA = { emitLine: vi.fn() };
    const viewerB = { emitLine: vi.fn() };
    const session = { flyAppName: 'pgs-app-a', viewers: new Map([['a', viewerA], ['b', viewerB]]) };

    broadcastLogLine(session, 'hello', '2026-01-01T00:00:00.000Z');

    expect(viewerA.emitLine).toHaveBeenCalledWith({ flyAppName: 'pgs-app-a', message: 'hello', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(viewerB.emitLine).toHaveBeenCalledWith({ flyAppName: 'pgs-app-a', message: 'hello', timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('emits nothing when there are zero viewers', () => {
    const session = { flyAppName: 'pgs-app-a', viewers: new Map() };
    expect(() => broadcastLogLine(session, 'hello', '2026-01-01T00:00:00.000Z')).not.toThrow();
  });
});
