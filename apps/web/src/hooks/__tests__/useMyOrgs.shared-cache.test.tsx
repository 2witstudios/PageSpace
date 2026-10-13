import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth,
  fetchJSON: vi.fn(async (url: string) => (await fetchWithAuth(url)).json()),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  ApiRequestError: class extends Error {},
}));
type Handler = (payload: unknown) => void;
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    handlers,
    on: (event: string, h: (payload: unknown) => void) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)?.add(h); },
    off: (event: string, h: (payload: unknown) => void) => { handlers.get(event)?.delete(h); },
    emit: vi.fn(),
  };
});
vi.mock('@/stores/useSocketStore', () => ({ useSocketStore: (select: (s: { socket: typeof socket; connect: () => void }) => unknown) => select({ socket, connect: () => undefined }) }));

import { useMyOrganizations } from '../useMyOrganizations';
import { useMyOrgs, useOrgRealtime } from '../useOrgs';

const northwind = { id: 'org_1', name: 'Northwind', slug: 'northwind', avatarUrl: null, role: 'MEMBER' as const, lapsed: false };
const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;

const serverSends = (event: string, payload: unknown) => socket.handlers.get(event)?.forEach((h: Handler) => h(payload));

beforeEach(() => {
  socket.handlers.clear();
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ organizations: [northwind] }), { status: 200 }));
});

describe('my organizations: one cache entry, one shape', () => {
  it('X-4 (partial) the org settings list and the picker read GET /api/orgs through one cache entry, so an org:changed refresh reaches both', async () => {
    // Both hooks mounted at once, as the picker and Account Settings are: neither may see the other's shape.
    const { result } = renderHook(() => ({ settings: useMyOrgs(), picker: useMyOrganizations() }), { wrapper });
    await waitFor(() => expect(result.current.picker.organizations).toHaveLength(1));
    expect(result.current.picker.orgById('org_1')?.name).toBe('Northwind');
    expect(result.current.settings.orgs).toEqual([northwind]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});

describe('the picker follows org changes without a reload', () => {
  it('X-4 (partial) an org:changed for a new membership refetches my orgs, so the picker gains the org header', async () => {
    const { result } = renderHook(() => { useOrgRealtime(); return useMyOrganizations(); }, { wrapper });
    await waitFor(() => expect(result.current.organizations).toHaveLength(1));

    const contoso = { ...northwind, id: 'org_2', name: 'Contoso' };
    fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ organizations: [northwind, contoso] }), { status: 200 }));
    serverSends('org:changed', { orgId: 'org_2', change: 'membership' });
    await waitFor(() => expect(result.current.orgById('org_2')?.name).toBe('Contoso'));
  });

  it('X-4 (partial) a rename reaches the picker; a policy change does not refetch the list', async () => {
    const { result } = renderHook(() => { useOrgRealtime(); return useMyOrganizations(); }, { wrapper });
    await waitFor(() => expect(result.current.organizations).toHaveLength(1));

    serverSends('org:changed', { orgId: 'org_1', change: 'policy' });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ organizations: [{ ...northwind, name: 'Northwind Labs' }] }), { status: 200 }));
    serverSends('org:changed', { orgId: 'org_1', change: 'profile' });
    await waitFor(() => expect(result.current.orgById('org_1')?.name).toBe('Northwind Labs'));
  });
});
