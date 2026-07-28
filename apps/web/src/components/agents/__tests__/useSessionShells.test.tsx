/**
 * The shells hook: optimistic add/remove, and 404-as-success on close.
 *
 * The close path is the one with history behind it. On the old surface a DELETE
 * that 404'd was treated as a failure, the row rolled back, and the retry hit
 * the same 404 — an unremovable row, forever. A 404 means the PTY (or the whole
 * sandbox that held it) is already gone, which is precisely what the click was
 * asking for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';
import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';

const { mockFetchWithAuth, mockPost } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: mockPost,
  del: vi.fn(),
}));

import { useSessionShells, withShell, withoutShell } from '../useSessionShells';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const shell = (shellId: string, name = shellId): ShellDTO => ({
  shellId,
  sessionId: 'conv-1',
  ownerId: 'user-1',
  name,
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
});

/** GET resolves the list; DELETE is routed to `onDelete`. */
function routeFetch(list: ShellDTO[], onDelete: () => Promise<unknown> = async () => jsonResponse({}, 200)) {
  mockFetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return onDelete();
    return Promise.resolve(jsonResponse({ shells: list }));
  });
}

beforeEach(() => {
  mockFetchWithAuth.mockReset();
  mockPost.mockReset();
});

describe('pure cache transforms', () => {
  it('withoutShell drops exactly one row and passes an empty cache through', () => {
    expect(withoutShell('sh-1')({ shells: [shell('sh-1'), shell('sh-2')] })).toEqual({ shells: [shell('sh-2')] });
    expect(withoutShell('sh-1')(undefined)).toBeUndefined();
  });

  it('withShell appends, and ignores a shellId already present', () => {
    // An optimistic add landing beside its own server echo must render one tab.
    expect(withShell(shell('sh-2'))({ shells: [shell('sh-1')] })).toEqual({
      shells: [shell('sh-1'), shell('sh-2')],
    });
    expect(withShell(shell('sh-1'))({ shells: [shell('sh-1')] })).toEqual({ shells: [shell('sh-1')] });
    expect(withShell(shell('sh-1'))(undefined)).toEqual({ shells: [shell('sh-1')] });
  });
});

describe('useSessionShells', () => {
  it('lists the shells of the session addressed by the conversation id', async () => {
    routeFetch([shell('sh-1')]);
    const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.shells).toHaveLength(1));
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions/conv-1/shells');
  });

  it('reads a 404 as "no shells" — the session may simply not exist yet', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));
    const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.shells).toEqual([]);
    expect(result.current.error).toBeUndefined();
  });

  it('surfaces a real list failure', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
  });

  it('does not fetch when nothing is selected', async () => {
    const { result } = renderHook(() => useSessionShells(null), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('serves a stable empty array before the first response', () => {
    routeFetch([]);
    const { result, rerender } = renderHook(() => useSessionShells('conv-1'), { wrapper });
    const first = result.current.shells;
    rerender();
    expect(result.current.shells).toBe(first);
  });

  describe('addShell', () => {
    it('POSTs and adds the server-minted shell to the list', async () => {
      routeFetch([]);
      mockPost.mockResolvedValue({ shell: shell('sh-1', 'shell-1') });
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        const created = await result.current.addShell();
        expect(created?.shellId).toBe('sh-1');
      });

      expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/conv-1/shells', {});
      expect(result.current.shells.map((s) => s.shellId)).toEqual(['sh-1']);
    });

    it('passes a name through when the caller supplies one', async () => {
      routeFetch([]);
      mockPost.mockResolvedValue({ shell: shell('sh-1', 'build') });
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.addShell('build');
      });
      expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/conv-1/shells', { name: 'build' });
    });

    it('accepts a bare DTO envelope as well as { shell }', async () => {
      routeFetch([]);
      mockPost.mockResolvedValue(shell('sh-1'));
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.addShell();
      });
      expect(result.current.shells.map((s) => s.shellId)).toEqual(['sh-1']);
    });

    it('rolls back a failed add', async () => {
      routeFetch([shell('sh-1')]);
      mockPost.mockRejectedValue(new Error('sandbox unavailable'));
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.shells).toHaveLength(1));

      await expect(
        act(async () => {
          await result.current.addShell();
        }),
      ).rejects.toThrow('sandbox unavailable');

      await waitFor(() => expect(result.current.shells.map((s) => s.shellId)).toEqual(['sh-1']));
    });

    it('is a no-op when nothing is selected', async () => {
      const { result } = renderHook(() => useSessionShells(null), { wrapper });
      await act(async () => {
        expect(await result.current.addShell()).toBeNull();
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('removeShell', () => {
    it('drops the row optimistically and DELETEs by shellId', async () => {
      routeFetch([shell('sh-1'), shell('sh-2')]);
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.shells).toHaveLength(2));

      await act(async () => {
        await result.current.removeShell('sh-1');
      });

      expect(result.current.shells.map((s) => s.shellId)).toEqual(['sh-2']);
      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions/conv-1/shells/sh-1', {
        method: 'DELETE',
      });
    });

    it('treats a 404 as success — the shell is already gone', async () => {
      routeFetch([shell('sh-1')], async () => jsonResponse({ error: 'Not found' }, 404));
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.shells).toHaveLength(1));

      await act(async () => {
        await result.current.removeShell('sh-1');
      });

      expect(result.current.shells).toEqual([]);
    });

    it('rolls the row back when the close genuinely fails', async () => {
      // The PTY may still be running (and billing); its only row must not vanish.
      routeFetch([shell('sh-1')], async () => jsonResponse({ error: 'still running' }, 500));
      const { result } = renderHook(() => useSessionShells('conv-1'), { wrapper });
      await waitFor(() => expect(result.current.shells).toHaveLength(1));

      await expect(
        act(async () => {
          await result.current.removeShell('sh-1');
        }),
      ).rejects.toThrow('still running');

      await waitFor(() => expect(result.current.shells.map((s) => s.shellId)).toEqual(['sh-1']));
    });

    it('is a no-op when nothing is selected', async () => {
      const { result } = renderHook(() => useSessionShells(null), { wrapper });
      await act(async () => {
        await result.current.removeShell('sh-1');
      });
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });
  });
});
