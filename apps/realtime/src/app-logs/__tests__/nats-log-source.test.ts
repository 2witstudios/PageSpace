import { describe, it, expect, vi, beforeEach } from 'vitest';

let configured = true;
vi.mock('@pagespace/lib/services/app-hosting/app-logs-env', () => ({
  resolveAppLogsNatsUrl: vi.fn(() => 'nats://[fdaa::3]:4223'),
  resolveAppLogsNatsToken: vi.fn(() => 'readonly-token'),
  isAppLogsNatsConfigured: vi.fn(() => configured),
}));

vi.mock('@pagespace/lib/services/app-hosting/app-hosting-env', () => ({
  resolvePublishedAppsOrgSlug: vi.fn(() => 'acme-org'),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

/** A fake NATS subscription: async-iterable over a fixed set of messages, tracks unsubscribe. */
function makeFakeSubscription(messages: string[]) {
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    [Symbol.asyncIterator]: async function* () {
      for (const text of messages) {
        yield { string: () => text };
      }
    },
  };
}

const connect = vi.fn();
vi.mock('nats', () => ({
  connect: (...args: unknown[]) => connect(...args),
}));

describe('nats-log-source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configured = true;
    // `sharedConnection` is module-level state in nats-log-source.ts — without
    // resetting the module registry it would leak a resolved connection
    // across tests, silently defeating every "does connect() get called"
    // assertion below (all but the first test would see it already cached).
    vi.resetModules();
  });

  it('throws without connecting when the firehose is not configured', async () => {
    configured = false;
    const { subscribeToAppLogs } = await import('../nats-log-source');

    await expect(subscribeToAppLogs('pgs-app-a', vi.fn())).rejects.toThrow(/not configured/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects with the resolved URL, org slug as user, and token as pass, and subscribes on the expected subject', async () => {
    const fakeSub = makeFakeSubscription([]);
    const nc = { subscribe: vi.fn(() => fakeSub) };
    connect.mockResolvedValue(nc);

    const { subscribeToAppLogs } = await import('../nats-log-source');
    await subscribeToAppLogs('pgs-app-a', vi.fn());

    expect(connect).toHaveBeenCalledWith({
      servers: 'nats://[fdaa::3]:4223',
      user: 'acme-org',
      pass: 'readonly-token',
    });
    expect(nc.subscribe).toHaveBeenCalledWith('logs.pgs-app-a.*.*');
  });

  it('calls onLine for every message the subscription yields', async () => {
    const fakeSub = makeFakeSubscription(['line one', 'line two']);
    const nc = { subscribe: vi.fn(() => fakeSub) };
    connect.mockResolvedValue(nc);

    const onLine = vi.fn();
    const { subscribeToAppLogs } = await import('../nats-log-source');
    await subscribeToAppLogs('pgs-app-a', onLine);

    // The message pump runs detached (`void (async () => ...)()`); flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onLine).toHaveBeenCalledWith('line one');
    expect(onLine).toHaveBeenCalledWith('line two');
  });

  it('an onLine callback that throws an Error is caught and does not stop later messages', async () => {
    const fakeSub = makeFakeSubscription(['bad', 'good']);
    const nc = { subscribe: vi.fn(() => fakeSub) };
    connect.mockResolvedValue(nc);

    const onLine = vi.fn((message: string) => {
      if (message === 'bad') throw new Error('boom');
    });
    const { subscribeToAppLogs } = await import('../nats-log-source');
    await subscribeToAppLogs('pgs-app-a', onLine);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onLine).toHaveBeenCalledWith('bad');
    expect(onLine).toHaveBeenCalledWith('good');
  });

  it('an onLine callback that throws a non-Error value is still caught and does not stop later messages', async () => {
    const fakeSub = makeFakeSubscription(['bad', 'good']);
    const nc = { subscribe: vi.fn(() => fakeSub) };
    connect.mockResolvedValue(nc);

    const onLine = vi.fn((message: string) => {
      if (message === 'bad') throw 'not an Error instance'; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    const { subscribeToAppLogs } = await import('../nats-log-source');
    await subscribeToAppLogs('pgs-app-a', onLine);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onLine).toHaveBeenCalledWith('bad');
    expect(onLine).toHaveBeenCalledWith('good');
  });

  it('unsubscribe() delegates to the underlying subscription', async () => {
    const fakeSub = makeFakeSubscription([]);
    const nc = { subscribe: vi.fn(() => fakeSub) };
    connect.mockResolvedValue(nc);

    const { subscribeToAppLogs } = await import('../nats-log-source');
    const subscription = await subscribeToAppLogs('pgs-app-a', vi.fn());
    subscription.unsubscribe();

    expect(fakeSub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reuses one shared connection across concurrent subscriptions', async () => {
    const nc = { subscribe: vi.fn(() => makeFakeSubscription([])) };
    connect.mockResolvedValue(nc);

    const { subscribeToAppLogs } = await import('../nats-log-source');
    await Promise.all([
      subscribeToAppLogs('pgs-app-a', vi.fn()),
      subscribeToAppLogs('pgs-app-b', vi.fn()),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('a failed connect does not poison future attempts — the next call retries', async () => {
    connect.mockRejectedValueOnce(new Error('connect refused'));
    const nc = { subscribe: vi.fn(() => makeFakeSubscription([])) };
    connect.mockResolvedValueOnce(nc);

    const { subscribeToAppLogs } = await import('../nats-log-source');
    await expect(subscribeToAppLogs('pgs-app-a', vi.fn())).rejects.toThrow('connect refused');

    // The retry must actually reach `connect` again, not reuse the rejected promise.
    await expect(subscribeToAppLogs('pgs-app-a', vi.fn())).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
