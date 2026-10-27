/**
 * The per-ENV bridge socket registry. Keyed by envId, not userId: one user's
 * two machines hold two live sockets. Copied from `ws-connections.ts` and
 * pinned here: the stale-cleanup sweep, the 5-minute session revalidation and
 * the CAS-on-socket-identity guard in unregister (a dead socket must never
 * cancel a live env's in-flight requests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@pagespace/lib/auth/session-service', () => ({ sessionService: { validateSession: vi.fn() } }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { sessionService } from '@pagespace/lib/auth/session-service';
import {
  registerEnvConnection,
  unregisterEnvConnection,
  getEnvConnection,
  getAuthorizedEnvConnection,
  getEnvConnectionMetadata,
  markEnvAuthorized,
  updateEnvLastPing,
  readEnvLiveConnection,
  onEnvConnectionLost,
  checkEnvConnectionHealth,
  verifyEnvConnectionFingerprint,
  triggerEnvCleanup,
  clearAllEnvConnectionsForTesting,
  ENV_SUPERSEDED_CLOSE_CODE,
  ENV_SUPERSEDED_CLOSE_REASON,
  ENV_SESSION_REVALIDATION_INTERVAL_MS,
  ENV_STALE_CONNECTION_TIMEOUT_MS,
} from '../ws-env-connections';
import { RequestCorrelator, CorrelationError } from '@/lib/env-bridge/correlator';

type FakeSocket = WebSocket & { readyState: number };
function socket(readyState = 1): FakeSocket {
  return { readyState, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as FakeSocket;
}

const NOW = new Date('2026-09-06T10:00:00.000Z');
const meta = (envId: string, over: Partial<Parameters<typeof registerEnvConnection>[2]> = {}) => ({
  userId: 'user-1',
  sessionId: `sess-${envId}`,
  enrollmentId: `enr-${envId}`,
  machinePublicKey: 'MCowBQYDK2VwAyEA',
  serverKeyId: 'k1',
  fingerprint: 'fp-1',
  sessionExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  wsToken: `tok-${envId}`,
  ...over,
});

describe('ws-env-connections — the per-env registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearAllEnvConnectionsForTesting();
    vi.mocked(sessionService.validateSession).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('given two envs for one user, should hold two live sockets at once (regression vs the per-user map)', () => {
    const a = socket();
    const b = socket();
    registerEnvConnection('env-a', a, meta('env-a'));
    registerEnvConnection('env-b', b, meta('env-b'));
    expect(getEnvConnection('env-a')).toBe(a);
    expect(getEnvConnection('env-b')).toBe(b);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
  });

  it('given a second socket for the SAME env, the newer should win and the older close with the documented code + reason', () => {
    const older = socket();
    const newer = socket();
    registerEnvConnection('env-a', older, meta('env-a'));
    registerEnvConnection('env-a', newer, meta('env-a'));
    expect(getEnvConnection('env-a')).toBe(newer);
    expect(older.close).toHaveBeenCalledWith(ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON);
    expect(getEnvConnectionMetadata(older)).toBeUndefined();
    expect(getEnvConnectionMetadata(newer)?.envId).toBe('env-a');
  });

  it('given the superseded socket then closes, its unregister should be a no-op (CAS on identity): no lost event, no cancellation of answered OR in-flight requests', async () => {
    const correlator = new RequestCorrelator<string>();
    const lost: string[] = [];
    const off = onEnvConnectionLost((envId) => {
      lost.push(envId);
      correlator.cancelGroup(envId, new CorrelationError('disconnected', 'gone'));
    });
    const older = socket();
    registerEnvConnection('env-a', older, meta('env-a'));
    markEnvAuthorized(older);
    const answered = correlator.open({ id: 'r1', group: 'env-a', timeoutMs: 10_000, send: () => {} });
    correlator.resolve('r1', 'done');
    const inFlight = correlator.open({ id: 'r2', group: 'env-a', timeoutMs: 10_000, send: () => {} });
    let inFlightState = 'pending';
    inFlight.then(() => (inFlightState = 'resolved'), () => (inFlightState = 'rejected'));

    const newer = socket();
    registerEnvConnection('env-a', newer, meta('env-a'));
    // The old socket's close handler runs AFTER the new one registered — the historical race.
    expect(unregisterEnvConnection('env-a', older)).toBe(false);
    await Promise.resolve();
    expect(lost).toEqual([]);
    expect(await answered).toBe('done');
    expect(inFlightState).toBe('pending');
    expect(getEnvConnection('env-a')).toBe(newer);
    off();
  });

  it('given the LIVE socket unregisters, should fire the lost listener exactly once so its pending requests cancel with a typed disconnected error', async () => {
    const correlator = new RequestCorrelator<string>();
    const lost: string[] = [];
    const off = onEnvConnectionLost((envId) => {
      lost.push(envId);
      correlator.cancelGroup(envId, new CorrelationError('disconnected', 'gone'));
    });
    const ws = socket();
    registerEnvConnection('env-a', ws, meta('env-a'));
    const pending = correlator.open({ id: 'r1', group: 'env-a', timeoutMs: 10_000, send: () => {} });
    expect(unregisterEnvConnection('env-a', ws)).toBe(true);
    expect(lost).toEqual(['env-a']);
    await expect(pending).rejects.toMatchObject({ kind: 'disconnected' });
    expect(getEnvConnection('env-a')).toBeUndefined();
    expect(getEnvConnectionMetadata(ws)).toBeUndefined();
    // A second unregister of the same dead socket is a no-op.
    expect(unregisterEnvConnection('env-a', ws)).toBe(false);
    expect(lost).toEqual(['env-a']);
    off();
  });

  it('should read the live-connection status the way the DTO expects: connecting while hello is pending, connected once authorized, null otherwise', () => {
    expect(readEnvLiveConnection('env-a')).toBeNull();
    const ws = socket();
    registerEnvConnection('env-a', ws, meta('env-a'));
    expect(readEnvLiveConnection('env-a')).toBe('connecting');
    markEnvAuthorized(ws);
    expect(readEnvLiveConnection('env-a')).toBe('connected');
    ws.readyState = 3;
    expect(readEnvLiveConnection('env-a')).toBeNull();
  });

  it('should hand out a socket for server→daemon frames ONLY when authorized and open (invariant 6 — nothing is sent to a socket that has not proven itself)', () => {
    const ws = socket();
    registerEnvConnection('env-a', ws, meta('env-a'));
    expect(getAuthorizedEnvConnection('env-a')).toBeUndefined();
    markEnvAuthorized(ws);
    expect(getAuthorizedEnvConnection('env-a')).toBe(ws);
    ws.readyState = 2;
    expect(getAuthorizedEnvConnection('env-a')).toBeUndefined();
  });

  it('should verify the fingerprint against what was registered', () => {
    const ws = socket();
    registerEnvConnection('env-a', ws, meta('env-a', { fingerprint: 'fp-1' }));
    expect(verifyEnvConnectionFingerprint(ws, 'fp-1')).toBe(true);
    expect(verifyEnvConnectionFingerprint(ws, 'fp-2')).toBe(false);
    expect(verifyEnvConnectionFingerprint(socket(), 'fp-1')).toBe(false);
  });

  describe('health check (mirrors checkConnectionHealth)', () => {
    it('given an unregistered socket, should be unhealthy: not registered', () => {
      expect(checkEnvConnectionHealth(socket())).toMatchObject({ isHealthy: false, reason: 'Connection not registered' });
    });
    it('given a registered but not-yet-authorized socket, should be unhealthy: authentication not completed', () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a'));
      expect(checkEnvConnectionHealth(ws)).toMatchObject({ isHealthy: false, reason: 'Authentication not completed' });
    });
    it('given a closed socket, should be unhealthy: not open', () => {
      const ws = socket(3);
      registerEnvConnection('env-a', ws, meta('env-a'));
      markEnvAuthorized(ws);
      expect(checkEnvConnectionHealth(ws).reason).toMatch(/not open/);
    });
    it('given an expired session, should be unhealthy: session expired', () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { sessionExpiresAt: new Date(NOW.getTime() - 1) }));
      markEnvAuthorized(ws);
      expect(checkEnvConnectionHealth(ws)).toMatchObject({ isHealthy: false, reason: 'Session expired', sessionExpired: true });
    });
    it('given an authorized, open, unexpired socket, should be healthy', () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a'));
      markEnvAuthorized(ws);
      updateEnvLastPing(ws);
      expect(checkEnvConnectionHealth(ws)).toMatchObject({ isHealthy: true, readyState: 1 });
    });
  });

  describe('stale-connection sweep (copied from ws-connections)', () => {
    it('given a socket that is already closed, should drop it from the map and fire the lost listener', async () => {
      const lost: string[] = [];
      const off = onEnvConnectionLost((envId) => lost.push(envId));
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a'));
      ws.readyState = 3;
      // The session is still valid: only the closed-socket check may remove it.
      vi.mocked(sessionService.validateSession).mockResolvedValue({ userId: 'user-1' } as never);
      await triggerEnvCleanup();
      expect(getEnvConnection('env-a')).toBeUndefined();
      expect(ws.close).not.toHaveBeenCalled();
      expect(lost).toEqual(['env-a']);
      off();
    });

    it('given an expired session, should close 1000 "Session expired" and drop it', async () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { sessionExpiresAt: new Date(NOW.getTime() + 1000) }));
      vi.setSystemTime(new Date(NOW.getTime() + 2000));
      await triggerEnvCleanup();
      expect(ws.close).toHaveBeenCalledWith(1000, 'Session expired');
      expect(getEnvConnection('env-a')).toBeUndefined();
    });

    it('given no ping for longer than the stale timeout, should close as inactive', async () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { sessionExpiresAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) }));
      vi.setSystemTime(new Date(NOW.getTime() + ENV_STALE_CONNECTION_TIMEOUT_MS + 1));
      vi.mocked(sessionService.validateSession).mockResolvedValue({ userId: 'user-1' } as never);
      await triggerEnvCleanup();
      expect(ws.close).toHaveBeenCalledWith(1000, 'Connection cleanup - inactive');
      expect(getEnvConnection('env-a')).toBeUndefined();
    });

    it('given a recent ping, should keep the socket', async () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { sessionExpiresAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) }));
      vi.setSystemTime(new Date(NOW.getTime() + ENV_STALE_CONNECTION_TIMEOUT_MS - 1000));
      updateEnvLastPing(ws);
      vi.setSystemTime(new Date(NOW.getTime() + ENV_STALE_CONNECTION_TIMEOUT_MS + 1000));
      vi.mocked(sessionService.validateSession).mockResolvedValue({ userId: 'user-1' } as never);
      await triggerEnvCleanup();
      expect(ws.close).not.toHaveBeenCalled();
      expect(getEnvConnection('env-a')).toBe(ws);
    });
  });

  describe('5-minute session revalidation (copied from ws-connections)', () => {
    it('given a token the session service no longer honours, should close 1008 "Session revoked", drop it and fire the lost listener', async () => {
      const lost: string[] = [];
      const off = onEnvConnectionLost((envId) => lost.push(envId));
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { wsToken: 'tok-a' }));
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);
      await triggerEnvCleanup();
      expect(sessionService.validateSession).toHaveBeenCalledWith('tok-a', { expectedType: 'mcp' });
      expect(ws.close).toHaveBeenCalledWith(1008, 'Session revoked');
      expect(getEnvConnection('env-a')).toBeUndefined();
      expect(lost).toEqual(['env-a']);
      off();
    });

    it('given a still-valid token, should keep the socket and not ask again within the interval', async () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { wsToken: 'tok-a' }));
      vi.mocked(sessionService.validateSession).mockResolvedValue({ userId: 'user-1' } as never);
      await triggerEnvCleanup();
      expect(sessionService.validateSession).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date(NOW.getTime() + ENV_SESSION_REVALIDATION_INTERVAL_MS - 1));
      await triggerEnvCleanup();
      expect(sessionService.validateSession).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date(NOW.getTime() + ENV_SESSION_REVALIDATION_INTERVAL_MS + 1));
      await triggerEnvCleanup();
      expect(sessionService.validateSession).toHaveBeenCalledTimes(2);
      expect(getEnvConnection('env-a')).toBe(ws);
    });

    it('given a transient validation error, should keep the socket (retry next interval, never close on an outage)', async () => {
      const ws = socket();
      registerEnvConnection('env-a', ws, meta('env-a', { wsToken: 'tok-a' }));
      vi.mocked(sessionService.validateSession).mockRejectedValue(new Error('db down'));
      await triggerEnvCleanup();
      expect(ws.close).not.toHaveBeenCalled();
      expect(getEnvConnection('env-a')).toBe(ws);
    });
  });
});
