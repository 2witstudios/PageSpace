/**
 * Kick client (#2158): the ONE web→realtime revocation-kick transport, moved
 * here from apps/web's socket-utils so the permission mutation layer can call
 * it directly. Kicks are best-effort by design — room membership is a delivery
 * optimization over the per-event permission recheck — so every failure mode
 * resolves to a `{ success: false }` result, never a throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../logging/logger-config', () => ({
  loggers: { realtime: mockLogger },
}));
vi.mock('../../auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': 't=1,v1=sig',
  })),
}));

import { kickUserFromRooms, type KickPayload } from '../kick-client';

const payload: KickPayload = {
  userId: 'user1',
  roomPattern: 'drive:tz4a98xxat96iws9zmbrgj3a',
  reason: 'member_removed',
  metadata: { driveId: 'tz4a98xxat96iws9zmbrgj3a', driveName: 'Team' },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_REALTIME_URL;
});

describe('kickUserFromRooms', () => {
  it('POSTs the signed payload to /api/kick and returns the realtime result', async () => {
    const kickResult = { success: true, kickedCount: 2, rooms: ['drive:tz4a98xxat96iws9zmbrgj3a'] };
    fetchMock.mockResolvedValue({ ok: true, json: async () => kickResult });

    const result = await kickUserFromRooms(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://realtime.test/api/kick');
    expect((init as { method: string }).method).toBe('POST');
    expect(JSON.parse((init as { body: string }).body)).toEqual(payload);
    expect(result).toEqual(kickResult);
  });

  it('skips (success: false) when INTERNAL_REALTIME_URL is not configured', async () => {
    delete process.env.INTERNAL_REALTIME_URL;

    const result = await kickUserFromRooms(payload);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.kickedCount).toBe(0);
  });

  it('resolves (never throws) when the realtime server rejects the request', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Authentication failed' });

    const result = await kickUserFromRooms(payload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('resolves (never throws) on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await kickUserFromRooms(payload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
