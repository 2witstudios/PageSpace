/**
 * useResolvedAgent — resolves the full AgentInfo an AgentView needs from just
 * an agentId, via two already-consumed endpoints (no new backend surface).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mockFetchWithAuth }));

vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (selector: (state: { drives: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ drives: [{ id: 'drive-1', name: 'Drive One' }] }),
}));

import { useResolvedAgent } from '../useResolvedAgent';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  mockFetchWithAuth.mockReset();
});

describe('useResolvedAgent', () => {
  it('combines the page fetch and the agent-config fetch into one AgentInfo, resolving driveName from the drive list', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/pages/agent-1') {
        return jsonResponse({ id: 'agent-1', title: 'My Agent', driveId: 'drive-1' });
      }
      if (url === '/api/pages/agent-1/agent-config') {
        return jsonResponse({
          systemPrompt: 'Be helpful.',
          enabledTools: ['search'],
          aiProvider: 'anthropic',
          aiModel: 'claude-sonnet-5',
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { result } = renderHook(() => useResolvedAgent('agent-1'), { wrapper });

    await waitFor(() => expect(result.current.agent).not.toBeNull());
    expect(result.current.agent).toEqual({
      id: 'agent-1',
      title: 'My Agent',
      driveId: 'drive-1',
      driveName: 'Drive One',
      systemPrompt: 'Be helpful.',
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-5',
      enabledTools: ['search'],
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to "Untitled agent" when the page has no title', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/pages/agent-1') return jsonResponse({ id: 'agent-1', title: null, driveId: 'drive-1' });
      return jsonResponse({});
    });

    const { result } = renderHook(() => useResolvedAgent('agent-1'), { wrapper });

    await waitFor(() => expect(result.current.agent?.title).toBe('Untitled agent'));
  });

  it('does not fetch when agentId is null', async () => {
    const { result } = renderHook(() => useResolvedAgent(null), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(result.current.agent).toBeNull();
  });

  it('surfaces a page-fetch failure as an error', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/api/pages/agent-1') return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({});
    });

    const { result } = renderHook(() => useResolvedAgent('agent-1'), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
  });
});
