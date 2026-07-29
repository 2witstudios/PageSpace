/**
 * The sandbox-status hook.
 *
 * These endpoints do not exist yet (they land with the API phase) — this suite
 * codes to the contract and mocks the wire, which is also what pins the one
 * behaviour the route must not talk us out of: **404 means "no sandbox", not
 * "something went wrong"**. Sessions are lazy, so most conversations 404 here
 * forever, and an error state on that path would paint the whole tree red in its
 * resting state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';
import type { AgentSessionDTO } from '@pagespace/lib/agent-sessions/contract';

const { mockFetchWithAuth, mockPost } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: mockPost,
  del: vi.fn(),
}));

import { useAgentSession } from '../useAgentSession';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const session = (overrides: Partial<AgentSessionDTO> = {}): AgentSessionDTO => ({
  sessionId: 'conv-1',
  ownerId: 'user-1',
  agentPageId: 'agent-1',
  name: 'Untitled',
  sandboxStatus: 'running',
  createdAt: '2026-07-28T00:00:00.000Z',
  lastActiveAt: null,
  endedAt: null,
  ...overrides,
});

beforeEach(() => {
  mockFetchWithAuth.mockReset();
  mockPost.mockReset();
});

describe('useAgentSession', () => {
  it('addresses the session by the conversation id — they are the same string', () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ session: session() }));
    renderHook(() => useAgentSession('conv-1'), { wrapper });
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions/conv-1');
  });

  it('reports the sandbox status of an existing session', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ session: session({ sandboxStatus: 'running' }) }));
    const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('running'));
    expect(result.current.session?.sessionId).toBe('conv-1');
    expect(result.current.error).toBeUndefined();
  });

  it('reads a 404 as "no sandbox", not as an error', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));
    const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBe('none');
    expect(result.current.session).toBeNull();
    expect(result.current.error).toBeUndefined();
  });

  it('reads an explicit null session as "no sandbox"', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ session: null }));
    const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBe('none');
  });

  it('reads the { session } envelope the route actually returns', async () => {
    // Written in the frontend phase, before the route existed, as "the hook is
    // not the reason it has to pick an envelope" — reasonable then. The route
    // has since picked `{ session }`, so accepting a bare DTO now pins
    // tolerance for a response nothing sends. Permissive client parsing is what
    // keeps a client/server divergence silent, which is exactly how the tool
    // layer's realtime hop went a whole rebuild speaking the wrong format.
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ session: session({ sandboxStatus: 'starting' }) }));
    const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('starting'));
  });

  it('surfaces a real failure as an error', async () => {
    // "We don't know" is not "there isn't one" — a user about to start a sandbox
    // deserves the difference.
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toBe('boom');
    // Still renderable: a status is always available.
    expect(result.current.status).toBe('none');
  });

  it('treats a network failure as an error too', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
  });

  it('does not fetch when nothing is selected', async () => {
    const { result } = renderHook(() => useAgentSession(null), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(result.current.status).toBe('none');
  });

  describe('ensureSession', () => {
    it('POSTs the same path the GET reads', async () => {
      mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));
      mockPost.mockResolvedValue({ session: session({ sandboxStatus: 'starting' }) });
      const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.status).toBe('none'));

      await act(async () => {
        await result.current.ensureSession();
      });

      expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/conv-1');
    });

    it('writes the ensured session into the cache immediately', async () => {
      // Provisioning is the one moment a stale 'none' actively misleads — the
      // chip would keep offering to start a sandbox that is already starting.
      mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));
      mockPost.mockResolvedValue({ session: session({ sandboxStatus: 'starting' }) });
      const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.status).toBe('none'));

      await act(async () => {
        await result.current.ensureSession();
      });

      expect(result.current.status).toBe('starting');
    });

    it('is a no-op when nothing is selected', async () => {
      const { result } = renderHook(() => useAgentSession(null), { wrapper });
      await act(async () => {
        expect(await result.current.ensureSession()).toBeNull();
      });
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('propagates a failed ensure — the user asked for compute and did not get it', async () => {
      mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));
      mockPost.mockRejectedValue(new Error('quota exceeded'));
      const { result } = renderHook(() => useAgentSession('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await expect(
        act(async () => {
          await result.current.ensureSession();
        }),
      ).rejects.toThrow('quota exceeded');
    });
  });
});
