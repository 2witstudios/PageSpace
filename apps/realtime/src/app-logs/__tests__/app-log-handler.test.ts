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
import { buildAppLogHandlers } from '../app-log-handler';
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
});
