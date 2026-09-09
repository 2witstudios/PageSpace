/**
 * `useEnvActivity` (GA wave 3, leaf 2): the HTTP read is the truth, the
 * owner-room `env:activity` event upserts into it by row id, other envs'
 * rows are ignored, a disabled (non-owner) hook mounts nothing, and a
 * reconnect re-reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args) }));

import { createMockSocket } from '@/test/socket-mocks';
import { useSocketStore } from '@/stores/useSocketStore';
import { useEnvActivity, upsertActivity, envActivityKey } from '../useEnvActivity';
import type { DriveEnvActivityDTO } from '@pagespace/lib/drive-envs/env-contract';

const row = (over: Partial<DriveEnvActivityDTO>): DriveEnvActivityDTO => ({ id: 'r1', envId: 'env-1', grantId: 'g-1', userId: 'u', sessionId: 's', conversationId: 'c', op: 'exec', summary: 'exec: ls', verdict: 'signed', exitCode: null, challengeId: null, approvalScope: null, ts: '2026-09-09T12:00:00.000Z', resultAt: null, ...over });

const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;

let socket: ReturnType<typeof createMockSocket>;

beforeEach(() => {
  vi.clearAllMocks();
  socket = createMockSocket();
  useSocketStore.setState({ socket: socket as never });
  mockFetchWithAuth.mockImplementation(async () => ({ ok: true, json: async () => ({ activity: [row({ id: 'r1' }), row({ id: 'r0', verdict: 'completed', exitCode: 0, resultAt: '2026-09-09T11:59:00.000Z' })] }) }));
});

describe('upsertActivity (pure)', () => {
  it('replaces a known id in place, prepends an unknown one, and stays bounded', () => {
    const current = [row({ id: 'a' }), row({ id: 'b' })];
    expect(upsertActivity(current, row({ id: 'b', verdict: 'completed' })).map((r) => [r.id, r.verdict])).toEqual([['a', 'signed'], ['b', 'completed']]);
    expect(upsertActivity(current, row({ id: 'c' })).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(upsertActivity(current, row({ id: 'c' }), 2).map((r) => r.id)).toEqual(['c', 'a']);
  });
});

describe('useEnvActivity', () => {
  it('reads the owner-only route once and splits running from the rest', async () => {
    const { result } = renderHook(() => useEnvActivity({ driveId: 'drive-1', envId: 'env-1' }), { wrapper });
    await waitFor(() => expect(result.current.activity).toHaveLength(2));
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/drives/drive-1/envs/env-1/activity');
    expect(result.current.running.map((r) => r.id)).toEqual(['r1']);
  });

  it('given an env:activity event for THIS env, upserts by id without a refetch; for another env, ignores it', async () => {
    const { result } = renderHook(() => useEnvActivity({ driveId: 'drive-1', envId: 'env-1' }), { wrapper });
    await waitFor(() => expect(result.current.activity).toHaveLength(2));
    expect(socket.on).toHaveBeenCalledWith('env:activity', expect.any(Function));
    act(() => socket._trigger('env:activity', row({ id: 'r1', verdict: 'completed', exitCode: 3, resultAt: '2026-09-09T12:00:05.000Z' })));
    await waitFor(() => expect(result.current.running).toHaveLength(0));
    expect(result.current.activity.find((r) => r.id === 'r1')).toMatchObject({ verdict: 'completed', exitCode: 3 });
    act(() => socket._trigger('env:activity', row({ id: 'r9', envId: 'env-other' })));
    act(() => socket._trigger('env:activity', row({ id: 'r2' })));
    await waitFor(() => expect(result.current.activity.map((r) => r.id)).toEqual(['r2', 'r1', 'r0']));
    expect(result.current.activity.some((r) => r.id === 'r9')).toBe(false);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('given a malformed event, ignores it rather than corrupting the list', async () => {
    const { result } = renderHook(() => useEnvActivity({ driveId: 'drive-1', envId: 'env-1' }), { wrapper });
    await waitFor(() => expect(result.current.activity).toHaveLength(2));
    act(() => socket._trigger('env:activity', { id: 'bad', envId: 'env-1' }));
    expect(result.current.activity).toHaveLength(2);
  });

  it('given enabled: false (not the owner), mounts NO key and NO listener — the 403 is never requested', () => {
    const { result } = renderHook(() => useEnvActivity({ driveId: 'drive-1', envId: 'env-1' }, { enabled: false }), { wrapper });
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalledWith('env:activity', expect.any(Function));
    expect(result.current.activity).toEqual([]);
  });

  it('on socket reconnect, re-reads the route (the truth), and unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useEnvActivity({ driveId: 'drive-1', envId: 'env-1' }), { wrapper });
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));
    act(() => socket._trigger('connect'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(2));
    unmount();
    expect(socket.off).toHaveBeenCalledWith('env:activity', expect.any(Function));
  });

  it('Codex P2 #6 (review round 1) — scope account reads the owner-scoped account route (no drive in the path), same event upsert', async () => {
    const { result } = renderHook(() => useEnvActivity({ driveId: 'drive-1', envId: 'env-1', scope: 'account' }), { wrapper });
    await waitFor(() => expect(result.current.activity).toHaveLength(2));
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/env-bridge/activity?envId=env-1');
    expect(envActivityKey({ driveId: null, envId: 'env-1', scope: 'account' })).toBe('/api/env-bridge/activity?envId=env-1');
  });

  it('envActivityKey is null without both ids', () => {
    expect(envActivityKey({ driveId: 'd', envId: null })).toBeNull();
    expect(envActivityKey({ driveId: 'd', envId: 'e' })).toBe('/api/drives/d/envs/e/activity');
  });
});
