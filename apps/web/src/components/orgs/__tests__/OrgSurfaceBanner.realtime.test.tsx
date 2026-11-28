/**
 * The app shell's org listener follows the org the screen belongs to (Layout: useOrgRealtime(useSurfaceOrgId())),
 * so the lapse banner on an org drive turns on — and off again — when org:changed arrives, without a reload.
 * The real useOrg / useOrgRealtime / SWR run here; only the socket and the network are faked.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/dashboard/d_org/page_1',
  memberOf: ['org_1'] as string[],
  notice: null as null | { kind: 'read_only'; canManageBilling: false },
  fetchJSON: vi.fn(),
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
}));
const socket = {
  on: (event: string, h: (payload: unknown) => void) => { if (!mocks.handlers.has(event)) mocks.handlers.set(event, new Set()); mocks.handlers.get(event)?.add(h); },
  off: (event: string, h: (payload: unknown) => void) => { mocks.handlers.get(event)?.delete(h); },
  emit: vi.fn(),
};

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../OrgPaymentForm', () => ({ OrgPaymentForm: () => null }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), fetchJSON: mocks.fetchJSON }));
vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: (select: (s: { socket: typeof socket; connect: () => void }) => unknown) => select({ socket, connect: () => undefined }),
}));
vi.mock('@/hooks/useDrive', () => ({ useDriveStore: (select: (s: { drives: { id: string; orgId: string | null }[] }) => unknown) => select({ drives: [{ id: 'd_org', orgId: 'org_1' }] }) }));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ refresh: vi.fn(), orgById: (id: string | null | undefined) => (id && mocks.memberOf.includes(id) ? { id } : null) }),
}));

import { useOrgRealtime } from '@/hooks/useOrgs';
import { useSurfaceOrgId } from '@/hooks/useSurfaceOrgId';
import { OrgSurfaceBanner } from '../OrgSurfaceBanner';

/** The two lines of Layout this test stands for: the listener on the screen's org, and the banner. */
function Shell() {
  useOrgRealtime(useSurfaceOrgId());
  return <OrgSurfaceBanner />;
}

const serverSends = (payload: unknown) => act(() => mocks.handlers.get('org:changed')?.forEach((h) => h(payload)));
const orgReads = () => mocks.fetchJSON.mock.calls.filter(([url]) => String(url).startsWith('/api/orgs/org_1')).length;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.memberOf = ['org_1'];
  mocks.notice = null;
  mocks.fetchJSON.mockImplementation(async (url: string) => {
    if (url === '/api/orgs/org_1') {
      return { organization: { id: 'org_1', name: 'Northwind Labs' }, viewer: { role: 'MEMBER' }, ...(mocks.notice ? { billingNotice: mocks.notice } : {}) };
    }
    throw new Error(`unexpected ${url}`);
  });
});

describe('the lapse banner follows org:changed live', () => {
  it('SEAT-9 (partial) X-4 (partial) on an org drive the banner appears when the org lapses and goes when it is paid, with no reload', async () => {
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Shell /></SWRConfig>);
    await waitFor(() => expect(orgReads()).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();

    mocks.notice = { kind: 'read_only', canManageBilling: false };
    serverSends({ orgId: 'org_1', change: 'status' });
    expect(await screen.findByText('Northwind Labs is read-only')).toBeTruthy();

    mocks.notice = null;
    serverSends({ orgId: 'org_1', change: 'status' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('a change to another org leaves this screen alone; a guest on the drive never reads the org', async () => {
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Shell /></SWRConfig>);
    await waitFor(() => expect(orgReads()).toBe(1));
    serverSends({ orgId: 'org_2', change: 'status' });
    await new Promise((r) => setTimeout(r, 20));
    expect(orgReads()).toBe(1);
  });

  it('SEAT-9 (partial) a guest on an org drive makes no org request at all', async () => {
    mocks.memberOf = [];
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Shell /></SWRConfig>);
    serverSends({ orgId: 'org_1', change: 'status' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.fetchJSON).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
