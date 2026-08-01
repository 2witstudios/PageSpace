import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useAgentMembership } from '../useAgentMembership';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn(), patch: vi.fn() }));

import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';

const mockFetchWithAuth = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;
const mockPatch = patch as unknown as ReturnType<typeof vi.fn>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

function membersResponse(role: string) {
  return {
    ok: true,
    json: async () => ({
      agentMembers: [{ agentPageId: 'agent-1', role, customRole: null }],
      currentUserRole: 'ADMIN',
    }),
  };
}
const rolesResponse = { ok: true, json: async () => ({ roles: [] }) };

describe('useAgentMembership', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockPatch.mockReset();
  });

  it('fetches members + roles for the drive and resolves this agent\'s membership', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) =>
      url.includes('/roles') ? rolesResponse : membersResponse('MEMBER'),
    );

    const { result } = renderHook(() => useAgentMembership('drive-1', 'agent-1'), { wrapper });

    expect(result.current.membership).toBeUndefined();
    await waitFor(() => expect(result.current.membership).not.toBeUndefined());
    expect(result.current.membership).toEqual({ role: 'MEMBER', customRole: null });
    expect(result.current.membershipUserRole).toBe('ADMIN');
  });

  // The whole point of this hook: two Settings surfaces for the SAME agent
  // must share one members fetch, and a role change from one must be
  // visible in the other without a manual local merge.
  it('updateRole revalidates the SHARED cache — a second hook instance for the same agent sees the new role with no extra local state', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) =>
      url.includes('/roles') ? rolesResponse : membersResponse('MEMBER'),
    );
    mockPatch.mockResolvedValue({ success: true });

    const cache = new Map();
    const sharedWrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children);

    const first = renderHook(() => useAgentMembership('drive-1', 'agent-1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(first.result.current.membership?.role).toBe('MEMBER'));

    // After the PATCH resolves, the members endpoint reflects the new role.
    mockFetchWithAuth.mockImplementation(async (url: string) =>
      url.includes('/roles') ? rolesResponse : membersResponse('ADMIN'),
    );

    await act(async () => {
      await first.result.current.updateRole('ADMIN');
    });

    expect(mockPatch).toHaveBeenCalledWith('/api/drives/drive-1/agents/agent-1', {
      role: 'ADMIN',
      customRoleId: null,
    });

    const second = renderHook(() => useAgentMembership('drive-1', 'agent-1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(second.result.current.membership?.role).toBe('ADMIN'));
    expect(first.result.current.membership?.role).toBe('ADMIN');
  });

  it('a custom role id sends customRoleId and MEMBER role', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) =>
      url.includes('/roles') ? rolesResponse : membersResponse('MEMBER'),
    );
    mockPatch.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useAgentMembership('drive-1', 'agent-1'), { wrapper });
    await waitFor(() => expect(result.current.membership).not.toBeUndefined());

    await act(async () => {
      await result.current.updateRole('custom-role-id');
    });

    expect(mockPatch).toHaveBeenCalledWith('/api/drives/drive-1/agents/agent-1', {
      role: 'MEMBER',
      customRoleId: 'custom-role-id',
    });
  });
});
