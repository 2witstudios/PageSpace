/**
 * useTabMeta — Agents tab branch. Covers the session-name title added on top
 * of the existing static "Agents" fallback: a selected session's own name
 * must win, switching sessions (a search-only change within the same tab)
 * must update the title rather than sticking to whatever was fetched first,
 * and no-session / not-yet-resolved / access-denied cases must all fall back
 * to the static title rather than a "Loading..." flicker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mockFetchWithAuth }));

import { useTabMeta } from '../useTabMeta';
import { createTab } from '@/lib/tabs/tab-navigation';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const sessionResponse = (name: string, driveId: string | null = 'drive-1') =>
  jsonResponse({ session: { sessionId: 'sess-1', driveId, name } });

beforeEach(() => {
  mockFetchWithAuth.mockReset();
});

describe('useTabMeta - Agents tab', () => {
  it('shows the static "Agents" title when no session is selected', async () => {
    const tab = createTab({ path: '/dashboard/agents', search: '' });

    const { result } = renderHook(() => useTabMeta(tab), { wrapper });

    expect(result.current.title).toBe('Agents');
    expect(result.current.iconName).toBe('Bot');
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows the selected session\'s own name once it resolves', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/agent-sessions/sess-1') return sessionResponse('Refactor auth flow');
      throw new Error(`unexpected url ${url}`);
    });
    const tab = createTab({ path: '/dashboard/agents', search: 'session=sess-1' });

    const { result } = renderHook(() => useTabMeta(tab), { wrapper });

    await waitFor(() => expect(result.current.title).toBe('Refactor auth flow'));
    expect(result.current.iconName).toBe('Bot');
  });

  it('falls back to the static "Agents" title while the session is still resolving', async () => {
    mockFetchWithAuth.mockImplementation(
      () => new Promise(() => {}), // never resolves within this test
    );
    const tab = createTab({ path: '/dashboard/agents', search: 'session=sess-1' });

    const { result } = renderHook(() => useTabMeta(tab), { wrapper });

    expect(result.current.title).toBe('Agents');
  });

  it('falls back to the static "Agents" title when the session doesn\'t resolve (e.g. access denied)', async () => {
    mockFetchWithAuth.mockImplementation(async () => jsonResponse({ session: null }));
    const tab = createTab({ path: '/dashboard/agents', search: 'session=sess-1' });

    const { result } = renderHook(() => useTabMeta(tab), { wrapper });

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    expect(result.current.title).toBe('Agents');
  });

  it('updates the title when the same tab switches to a different session', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/agent-sessions/sess-1') return sessionResponse('First Session');
      if (url === '/api/agent-sessions/sess-2') return jsonResponse({ session: { sessionId: 'sess-2', driveId: 'drive-1', name: 'Second Session' } });
      throw new Error(`unexpected url ${url}`);
    });
    const firstTab = createTab({ path: '/dashboard/agents', search: 'session=sess-1' });

    const { result, rerender } = renderHook((tab) => useTabMeta(tab), { wrapper, initialProps: firstTab });

    await waitFor(() => expect(result.current.title).toBe('First Session'));

    // Simulate useAgentSurfaceStore.commit() mirroring a new selection onto
    // this tab's `search` via updateActiveTabSearch — same tab id/path, only
    // the query string changes.
    const secondTab = { ...firstTab, search: 'session=sess-2' };
    rerender(secondTab);

    await waitFor(() => expect(result.current.title).toBe('Second Session'));
  });

  it('reverts to the static "Agents" title when the session selection is cleared', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/agent-sessions/sess-1') return sessionResponse('First Session');
      throw new Error(`unexpected url ${url}`);
    });
    const selectedTab = createTab({ path: '/dashboard/agents', search: 'session=sess-1' });

    const { result, rerender } = renderHook((tab) => useTabMeta(tab), { wrapper, initialProps: selectedTab });

    await waitFor(() => expect(result.current.title).toBe('First Session'));

    rerender({ ...selectedTab, search: '' });

    await waitFor(() => expect(result.current.title).toBe('Agents'));
  });

  it('applies the same session-name behavior to drive-scoped Agents tabs', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/agent-sessions/sess-1') return sessionResponse('Drive Session', 'drive-1');
      throw new Error(`unexpected url ${url}`);
    });
    const tab = createTab({ path: '/dashboard/drive-1/agents', search: 'session=sess-1' });

    const { result } = renderHook(() => useTabMeta(tab), { wrapper });

    await waitFor(() => expect(result.current.title).toBe('Drive Session'));
  });
});
