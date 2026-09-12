/**
 * `broadcastEnvActivity` (GA wave 3, leaf 2): ONE room — the machine OWNER's
 * own sessions room — and never a drive room, because the payload names a
 * command. Fire-and-forget: a failed broadcast is logged, never thrown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({ createSignedBroadcastHeaders: vi.fn(() => ({ 'content-type': 'application/json', 'x-signature': 'sig' })) }));
vi.mock('@pagespace/lib/logging/logger-browser', () => ({ browserLoggers: { realtime: { child: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }) } } }));

import { broadcastEnvActivity } from '../env-activity-events';
import { userSessionsRoom } from '@pagespace/lib/realtime/rooms';

const activity = { id: 'row-1', envId: 'env-1', grantId: 'g-1', userId: 'user-agent', sessionId: 's', conversationId: 'c', op: 'exec' as const, summary: "exec: sh -c 'git status'", verdict: 'signed', exitCode: null, challengeId: null, approvalScope: null, ts: '2026-09-09T12:00:00.000Z', resultAt: null };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_REALTIME_URL = 'http://realtime.internal';
  vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_REALTIME_URL;
});

describe('broadcastEnvActivity', () => {
  it('sends the row as env:activity to the OWNER\'s sessions room — the owner named, not the principal on the row', () => {
    broadcastEnvActivity({ ownerId: 'user-owner', activity });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://realtime.internal/api/broadcast');
    const body = JSON.parse(init.body) as { channelId: string; event: string; payload: unknown };
    expect(body.channelId).toBe(userSessionsRoom('user-owner'));
    expect(body.channelId).toBe('user:user-owner:sessions');
    expect(body.channelId).not.toContain('user-agent');
    expect(body.event).toBe('env:activity');
    expect(body.payload).toEqual(activity);
  });

  it('with no realtime URL configured, sends nothing and does not throw', () => {
    delete process.env.INTERNAL_REALTIME_URL;
    expect(() => broadcastEnvActivity({ ownerId: 'user-owner', activity })).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a rejected fetch is swallowed — a grant never fails because the realtime service did', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(() => broadcastEnvActivity({ ownerId: 'user-owner', activity })).not.toThrow();
    await Promise.resolve();
  });
});
