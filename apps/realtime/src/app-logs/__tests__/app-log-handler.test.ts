import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database — a queue of resolved values, one per `.limit()` call, so
// each test can script the env lookup then the published-app lookup that
// `resolveAuthorizedFlyAppName` makes in sequence.
const limitQueue: unknown[][] = [];
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(limitQueue.shift() ?? [])),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ a, b })),
}));

vi.mock('@pagespace/db/schema/drive-envs', () => ({ driveEnvs: {} }));
vi.mock('@pagespace/db/schema/published-apps', () => ({ publishedApps: {} }));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

const subscribeToAppLogs = vi.fn();
vi.mock('../nats-log-source', () => ({
  subscribeToAppLogs: (...args: unknown[]) => subscribeToAppLogs(...args),
}));

vi.mock('@pagespace/lib/services/app-hosting/app-logs-env', () => ({
  isAppLogsNatsConfigured: vi.fn(() => true),
}));

import { getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { isAppLogsNatsConfigured } from '@pagespace/lib/services/app-hosting/app-logs-env';
import { buildAppLogHandlers, IDLE_UNSUBSCRIBE_MS } from '../app-log-handler';
import { createAppLogSessionMap } from '../app-log-session-map';

function makeSocket(userId: string | undefined, id = 'socket-1') {
  return {
    id,
    data: { user: userId ? { id: userId } : undefined },
    emit: vi.fn(),
  };
}

describe('app-log-handler onSubscribe payload contract', () => {
  beforeEach(() => {
    limitQueue.length = 0;
    subscribeToAppLogs.mockReset();
    subscribeToAppLogs.mockResolvedValue({ unsubscribe: vi.fn() });
    vi.mocked(getUserDriveAccess).mockReset();
  });

  it('no-ops on a null subscribe payload', async () => {
    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe(null);

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
  });

  it('refuses when the env itself does not resolve', async () => {
    limitQueue.push([]); // env lookup finds nothing

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-missing', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
    expect(getUserDriveAccess).not.toHaveBeenCalled();
  });

  it('refuses when the env has no published app at all', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], []); // env found, no published_apps row
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
  });

  it('no-ops on a payload missing envId (the exact shipped regression)', async () => {
    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
    expect(sessionMap.getByApp('pgs-app-abc')).toBeUndefined();
  });

  it('subscribes when envId + flyAppName are authorized', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).toHaveBeenCalledWith('pgs-app-abc', expect.any(Function));
    expect(sessionMap.getByApp('pgs-app-abc')).toBeDefined();
  });

  it('refuses when the caller lacks drive access to the env', async () => {
    limitQueue.push([{ driveId: 'drive-1' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(false);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
  });

  it('refuses when the claimed flyAppName does not match the env\'s actual app', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-real' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-spoofed' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
    expect(sessionMap.getByApp('pgs-app-spoofed')).toBeUndefined();
  });

  it('no-ops when the socket carries no authenticated user', async () => {
    const socket = makeSocket(undefined);
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
  });

  it('a thrown authorization lookup is caught and refuses rather than propagating', async () => {
    vi.mocked(getUserDriveAccess).mockRejectedValue(new Error('db unavailable'));
    limitQueue.push([{ driveId: 'drive-1' }]);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await expect(handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' })).resolves.toBeUndefined();
    expect(subscribeToAppLogs).not.toHaveBeenCalled();
  });

  it('a thrown non-Error authorization failure is still caught and refuses', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    vi.mocked(getUserDriveAccess).mockRejectedValue('db unavailable');
    limitQueue.push([{ driveId: 'drive-1' }]);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await expect(handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' })).resolves.toBeUndefined();
    expect(subscribeToAppLogs).not.toHaveBeenCalled();
  });

  it('a second authorized subscriber joins the existing session instead of opening a new NATS subscription', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const sessionMap = createAppLogSessionMap();
    const first = buildAppLogHandlers(makeSocket('user-1', 'socket-1'), sessionMap);
    const second = buildAppLogHandlers(makeSocket('user-2', 'socket-2'), sessionMap);

    await first.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });
    await second.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).toHaveBeenCalledTimes(1);
    expect(sessionMap.getByApp('pgs-app-abc')?.viewers.size).toBe(2);
  });

  it('joining an existing session clears its idle timer so an about-to-reap session survives', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const sessionMap = createAppLogSessionMap();
    const socket1 = makeSocket('user-1', 'socket-1');
    const first = buildAppLogHandlers(socket1, sessionMap);
    await first.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    // Simulate the idle-arm that runs when the sole viewer detaches.
    first.onUnsubscribe({ flyAppName: 'pgs-app-abc' });
    const session = sessionMap.getByApp('pgs-app-abc');
    expect(session?.idleTimer).toBeDefined();

    const second = buildAppLogHandlers(makeSocket('user-2', 'socket-2'), sessionMap);
    await second.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(sessionMap.getByApp('pgs-app-abc')?.idleTimer).toBeUndefined();
  });

  it('refuses to open a new subscription when the log firehose is not configured', async () => {
    vi.mocked(isAppLogsNatsConfigured).mockReturnValueOnce(false);
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(subscribeToAppLogs).not.toHaveBeenCalled();
    expect(sessionMap.getByApp('pgs-app-abc')).toBeUndefined();
  });

  it('a NATS subscribe failure is caught and leaves no session behind', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    subscribeToAppLogs.mockRejectedValue(new Error('nats connect refused'));

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await expect(handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' })).resolves.toBeUndefined();
    expect(sessionMap.getByApp('pgs-app-abc')).toBeUndefined();
  });

  it('a NATS subscribe failure thrown as a non-Error value is still caught and leaves no session behind', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    subscribeToAppLogs.mockRejectedValue('nats connect refused');

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await expect(handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' })).resolves.toBeUndefined();
    expect(sessionMap.getByApp('pgs-app-abc')).toBeUndefined();
  });

  it('a session installed by a racing subscribe while this one awaited connect is joined, and the redundant subscription is closed', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    const redundantUnsubscribe = vi.fn();
    const sessionMap = createAppLogSessionMap();
    // The race: by the time `subscribeToAppLogs` resolves, another subscriber
    // has already installed a session for this app.
    subscribeToAppLogs.mockImplementation(async () => {
      sessionMap.setNew({ flyAppName: 'pgs-app-abc', unsubscribe: vi.fn(), viewers: new Map() });
      return { unsubscribe: redundantUnsubscribe };
    });

    const socket = makeSocket('user-1');
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(redundantUnsubscribe).toHaveBeenCalledTimes(1);
    expect(sessionMap.getByApp('pgs-app-abc')?.viewers.size).toBe(1);
  });
});

describe('app-log-handler — one socket watching two apps independently', () => {
  beforeEach(() => {
    limitQueue.length = 0;
    subscribeToAppLogs.mockReset();
    vi.mocked(getUserDriveAccess).mockReset();
  });

  it('unsubscribing from one app leaves the other subscription live, and disconnect tears down both', async () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    subscribeToAppLogs.mockImplementation((flyAppName: string) =>
      Promise.resolve({ unsubscribe: flyAppName === 'pgs-app-a' ? unsubscribeA : unsubscribeB }),
    );
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    // Two envs, each resolving to a different app — one socket, two subscribes.
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-a' }]);
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-b' }]);

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);

    await handlers.onSubscribe({ envId: 'env-a', flyAppName: 'pgs-app-a' });
    await handlers.onSubscribe({ envId: 'env-b', flyAppName: 'pgs-app-b' });

    expect(sessionMap.getByApp('pgs-app-a')).toBeDefined();
    expect(sessionMap.getByApp('pgs-app-b')).toBeDefined();

    // Without per-(socket,app) viewer keys, this would have removed the
    // viewer from whichever session the single shared key last pointed at
    // (app B, since it subscribed second) — leaving app A's viewer entry
    // permanently orphaned and never idle-reaped.
    handlers.onUnsubscribe({ flyAppName: 'pgs-app-a' });

    expect(unsubscribeA).not.toHaveBeenCalled(); // idle-armed, not torn down synchronously
    expect(sessionMap.getByApp('pgs-app-a')?.viewers.size).toBe(0);
    expect(sessionMap.getByApp('pgs-app-b')?.viewers.size).toBe(1); // untouched by A's unsubscribe

    handlers.onDisconnect();

    expect(sessionMap.getByApp('pgs-app-b')?.viewers.size).toBe(0);
  });

  it('a received NATS line reaches the socket via emitLine, stamped with the app name', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    let capturedOnLine: ((message: string) => void) | undefined;
    subscribeToAppLogs.mockImplementation((_flyAppName: string, onLine: (message: string) => void) => {
      capturedOnLine = onLine;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);
    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    expect(capturedOnLine).toBeDefined();
    capturedOnLine?.('hello world');

    expect(socket.emit).toHaveBeenCalledWith(
      'app:logs:line',
      expect.objectContaining({ flyAppName: 'pgs-app-abc', message: 'hello world' }),
    );
  });

  it('a NATS line delivered after the session was torn down is dropped rather than throwing', async () => {
    limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    let capturedOnLine: ((message: string) => void) | undefined;
    subscribeToAppLogs.mockImplementation((_flyAppName: string, onLine: (message: string) => void) => {
      capturedOnLine = onLine;
      return Promise.resolve({ unsubscribe: vi.fn() });
    });

    const socket = makeSocket('user-1');
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(socket, sessionMap);
    await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

    sessionMap.deleteByApp('pgs-app-abc');

    expect(() => capturedOnLine?.('too late')).not.toThrow();
    expect(socket.emit).not.toHaveBeenCalledWith('app:logs:line', expect.anything());
  });

  it('the armed idle timer actually tears the session down once it fires with no viewers left', async () => {
    vi.useFakeTimers();
    try {
      limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      const unsubscribe = vi.fn();
      subscribeToAppLogs.mockResolvedValue({ unsubscribe });

      const sessionMap = createAppLogSessionMap();
      const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
      await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

      handlers.onUnsubscribe({ flyAppName: 'pgs-app-abc' });
      expect(sessionMap.getByApp('pgs-app-abc')).toBeDefined(); // idle-armed, not torn down yet

      await vi.advanceTimersByTimeAsync(IDLE_UNSUBSCRIBE_MS);

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(sessionMap.getByApp('pgs-app-abc')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-attach before the idle timer fires cancels the teardown', async () => {
    vi.useFakeTimers();
    try {
      limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
      limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      const unsubscribe = vi.fn();
      subscribeToAppLogs.mockResolvedValue({ unsubscribe });

      const sessionMap = createAppLogSessionMap();
      const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
      await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });
      handlers.onUnsubscribe({ flyAppName: 'pgs-app-abc' });

      const second = buildAppLogHandlers(makeSocket('user-2', 'socket-2'), sessionMap);
      await second.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

      await vi.advanceTimersByTimeAsync(IDLE_UNSUBSCRIBE_MS);

      expect(unsubscribe).not.toHaveBeenCalled();
      expect(sessionMap.getByApp('pgs-app-abc')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onUnsubscribe with a malformed payload is a no-op', () => {
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
    expect(() => handlers.onUnsubscribe({})).not.toThrow();
  });

  it('arming an idle timer on a session already deleted from the map is a no-op (defensive race guard)', async () => {
    vi.useFakeTimers();
    try {
      limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      subscribeToAppLogs.mockResolvedValue({ unsubscribe: vi.fn() });

      const sessionMap = createAppLogSessionMap();
      const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
      await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

      // Simulate the session vanishing (e.g. torn down by another path)
      // between `removeViewer` returning it and `armIdleUnsubscribe` running.
      sessionMap.deleteByApp('pgs-app-abc');
      expect(() => handlers.onUnsubscribe({ flyAppName: 'pgs-app-abc' })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arming an idle timer on a session that already has one clears the stale timer first (defensive double-arm guard)', async () => {
    vi.useFakeTimers();
    try {
      limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      subscribeToAppLogs.mockResolvedValue({ unsubscribe: vi.fn() });

      const sessionMap = createAppLogSessionMap();
      const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
      await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });

      // Poke a pre-existing timer onto the session directly — simulating the
      // race `armIdleUnsubscribe`'s own `idleTimer !== undefined` guard
      // exists for (arm called while a stale timer from an earlier arm is
      // still pending) — before the real detach-to-zero arms its own.
      const session = sessionMap.getByApp('pgs-app-abc')!;
      const staleTimer = setTimeout(() => {}, 999_999);
      session.idleTimer = staleTimer;

      handlers.onUnsubscribe({ flyAppName: 'pgs-app-abc' });

      expect(session.idleTimer).toBeDefined();
      expect(session.idleTimer).not.toBe(staleTimer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an idle timer that fires while a viewer is (defensively) still attached does not tear the session down', async () => {
    vi.useFakeTimers();
    try {
      limitQueue.push([{ driveId: 'drive-1' }], [{ flyAppName: 'pgs-app-abc' }]);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      const unsubscribe = vi.fn();
      subscribeToAppLogs.mockResolvedValue({ unsubscribe });

      const sessionMap = createAppLogSessionMap();
      const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
      await handlers.onSubscribe({ envId: 'env-1', flyAppName: 'pgs-app-abc' });
      handlers.onUnsubscribe({ flyAppName: 'pgs-app-abc' }); // arms the timer

      // Add a viewer back WITHOUT going through the join path that would
      // clear the timer — simulating the defensive case the timer callback's
      // own viewer-count check exists for.
      sessionMap.addViewer('pgs-app-abc', 'synthetic-viewer', { emitLine: vi.fn() });

      await vi.advanceTimersByTimeAsync(IDLE_UNSUBSCRIBE_MS);

      expect(unsubscribe).not.toHaveBeenCalled();
      expect(sessionMap.getByApp('pgs-app-abc')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onUnsubscribe with a null payload is a no-op', () => {
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
    expect(() => handlers.onUnsubscribe(null)).not.toThrow();
  });

  it('onDisconnect with no active subscriptions is a no-op', () => {
    const sessionMap = createAppLogSessionMap();
    const handlers = buildAppLogHandlers(makeSocket('user-1'), sessionMap);
    expect(() => handlers.onDisconnect()).not.toThrow();
  });
});
