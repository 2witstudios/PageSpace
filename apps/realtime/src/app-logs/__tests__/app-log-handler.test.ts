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
  isAppLogsNatsConfigured: vi.fn(() => true),
  subscribeToAppLogs: (...args: unknown[]) => subscribeToAppLogs(...args),
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
