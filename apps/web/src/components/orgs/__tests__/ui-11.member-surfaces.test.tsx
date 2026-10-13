/**
 * UI-11 in one place: every org surface, rendered for a plain Member of Northwind Labs, degrades the
 * way the spec says. A Member sees no org settings beyond leaving the org — the hub offers only the
 * Drives directory (DRV-6, not a setting) and Leave; every settings page refuses them and asks the
 * server for nothing; the Drives directory lets them open and ask to join; join requests are not
 * theirs to answer; the picker's org group offers the directory; the lapse banner is the read-only
 * notice; the drive's Organization card is read-only; the drive Wallet page is the consumer view.
 *
 * The admin-only reads are the REAL hooks (useOrgAdminRead and friends): for a Member their SWR key is
 * null, so the test also proves no admin route is ever called.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drive } from '@pagespace/lib/types';
import type { OrgDriveDirectoryEntry } from '@/lib/orgs/org-api';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: '/orgs/org_nw/settings',
  fetchWithAuth: vi.fn(),
  fetchJSON: vi.fn(),
  walletRead: null as unknown,
}));
const NORTHWIND = { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, role: 'MEMBER' as const, lapsed: true };
const READ_ONLY = { kind: 'read_only' as const, canManageBilling: false as const };

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ orgId: 'org_nw', driveId: 'd-product' }),
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWithAuth: mocks.fetchWithAuth,
  fetchJSON: mocks.fetchJSON,
}));
vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: (select: (s: { socket: null; connect: () => void }) => unknown) => select({ socket: null, connect: () => undefined }),
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ organizations: [NORTHWIND], loaded: [NORTHWIND], orgById: (id: string | null | undefined) => (id === NORTHWIND.id ? NORTHWIND : null), refresh: vi.fn(), isLoading: false }),
}));
vi.mock('@/hooks/useOrgs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useOrgs')>()),
  useOrg: (id: string | undefined) => ({
    org: id === 'org_nw'
      ? { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_owner', createdAt: '2026-09-01T00:00:00Z' }, viewer: { userId: 'u_me', role: 'MEMBER' }, billingNotice: READ_ONLY }
      : undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgDriveDirectory: () => ({ data: { drives: DIRECTORY }, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/hooks/useDriveWallet', () => ({ useDriveWallet: () => ({ read: mocks.walletRead, wallet: null, isLoading: false, refresh: vi.fn() }) }));
vi.mock('@/hooks/useDriveMemberNames', () => ({ useDriveMemberNames: () => ({}) }));
vi.mock('@/components/layout/left-sidebar/CreateDriveDialog', () => ({ default: () => null }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../OrgPaymentForm', () => ({ OrgPaymentForm: () => null }));

import { projectDriveWallet } from '@pagespace/lib/billing/wallet-views';
import { walletActionsFor } from '@pagespace/lib/permissions/wallet-access';
import OrgSettingsPage from '@/app/orgs/[orgId]/settings/page';
import AttentionPage from '@/app/orgs/[orgId]/settings/attention/page';
import AuditPage from '@/app/orgs/[orgId]/settings/audit/page';
import BillingPage from '@/app/orgs/[orgId]/settings/billing/page';
import DangerPage from '@/app/orgs/[orgId]/settings/danger/page';
import DrivesSettingsPage from '@/app/orgs/[orgId]/settings/drives/page';
import GeneralPage from '@/app/orgs/[orgId]/settings/general/page';
import MembersPage from '@/app/orgs/[orgId]/settings/members/page';
import PoliciesPage from '@/app/orgs/[orgId]/settings/policies/page';
import SecurityPage from '@/app/orgs/[orgId]/settings/security/page';
import OrgDrivesDirectoryPage from '@/app/orgs/[orgId]/drives/page';
import DriveWalletSettingsPage from '@/app/dashboard/[driveId]/settings/wallet/page';
import DriveSwitcherDialog from '@/components/layout/navbar/DriveSwitcherDialog';
import { DriveJoinRequests } from '@/components/members/DriveJoinRequests';
import { OrgDriveCard } from '@/components/drives/OrgDriveCard';
import { OrgSurfaceBanner } from '../OrgSurfaceBanner';
import { useDriveStore } from '@/hooks/useDrive';
import { useFavorites } from '@/hooks/useFavorites';

const lead = { id: 'u_lead', name: 'Priya', image: null };
const DIRECTORY: OrgDriveDirectoryEntry[] = [
  { id: 'd-product', name: 'Product', slug: 'product', orgVisibility: 'OPEN', lead, joined: true, joinRequest: null, canRequest: false },
  { id: 'd-finance', name: 'Finance', slug: 'finance', orgVisibility: 'RESTRICTED', lead, joined: false, joinRequest: null, canRequest: true },
];
const product: Drive = {
  id: 'd-product', name: 'Product', slug: 'product', ownerId: 'u_lead', isTrashed: false, trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: false, orgId: 'org_nw', orgVisibility: 'RESTRICTED',
};
const SETTINGS_PAGES = [AttentionPage, AuditPage, BillingPage, DangerPage, DrivesSettingsPage, GeneralPage, MembersPage, PoliciesPage, SecurityPage];
const wrap = (node: React.ReactNode) => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>);
const calledUrls = () => [...mocks.fetchWithAuth.mock.calls, ...mocks.fetchJSON.mock.calls].map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ members: [] }), { status: 200 }));
  mocks.fetchJSON.mockImplementation(async () => ({}));
  useDriveStore.setState({ drives: [product], currentDriveId: null, isLoading: false, lastFetched: Date.now() });
  useFavorites.setState({ driveIds: new Set(), pageIds: new Set(), favorites: [], isSynced: true, isLoading: false, addFavorite: vi.fn(async () => {}), removeFavorite: vi.fn(async () => {}) });
  mocks.walletRead = {
    viewer: 'member',
    actions: walletActionsFor('member', { orgDrive: true }),
    wallet: projectDriveWallet('member', {
      wallet: {
        id: 'w-product', driveId: 'd-product', status: 'active', monthlyAllowanceCents: 120_000, spentCents: 100_800, topupRemainingCents: 0, debtCents: 0,
        monthlyPeriodStart: null, monthlyPeriodEnd: null, fallbackRule: 'seat_allowance', donationsEnabled: true, defaultSpendSource: 'drive_wallet', overshootChoice: null,
      },
      myCap: null,
      spendByConsumer: [{ consumerKey: 'user:u-other', userId: 'u-other', displayName: 'Other Person', spentCents: 64_513, spentTodayCents: 0, viaAutomationsCents: 0 }],
      pool: { walletId: 'w-pool', availableCents: 900_017, outstandingChildAllocationsCents: 0 },
    }),
  };
});

describe('a plain Member across every org surface', () => {
  it('UI-11 every surface degrades for a plain Member: no org settings beyond leaving; the Drives directory and asking to join are theirs; read-only notice, read-only drive card, consumer wallet view', () => {
    // The hub: the Drives directory and Leave, nothing under /settings.
    const hub = wrap(<OrgSettingsPage />);
    expect(screen.getByRole('link', { name: /Drives directory/ }).getAttribute('href')).toBe('/orgs/org_nw/drives');
    expect(screen.getByRole('button', { name: /Leave Northwind Labs/ })).toBeTruthy();
    expect(screen.queryAllByRole('link').some((a) => a.getAttribute('href')?.includes('/settings/'))).toBe(false);
    hub.unmount();

    // Every settings page refuses them, with no controls.
    for (const Page of SETTINGS_PAGES) {
      const view = wrap(<Page />);
      expect(screen.getByText(/^Only the Owner( or an Admin)? of Northwind Labs can see this page\.$/)).toBeTruthy();
      expect(screen.queryAllByRole('button').filter((b) => !b.closest('a'))).toHaveLength(0);
      expect(screen.queryByRole('textbox')).toBeNull();
      view.unmount();
    }
    // ...and no admin read was ever asked for.
    expect(calledUrls().filter((u) => u.startsWith('/api/orgs/'))).toEqual([]);

    // The Drives directory: open what they are on, ask to join a Restricted drive.
    const directory = wrap(<OrgDrivesDirectoryPage />);
    expect(within(screen.getByRole('region', { name: 'Your drives' })).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/dashboard/d-product');
    expect(within(screen.getByRole('region', { name: 'Ask to join' })).getByRole('button', { name: 'Ask to join' })).toBeTruthy();
    directory.unmount();

    // Join requests are the lead's and the admins': nothing renders, nothing is fetched.
    const requests = wrap(<DriveJoinRequests drive={product} />);
    expect(requests.container.textContent).toBe('');
    expect(calledUrls().some((u) => u.includes('/join-requests'))).toBe(false);
    requests.unmount();

    // The picker's org group offers the directory.
    const picker = wrap(<DriveSwitcherDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('option', { name: 'Browse Northwind Labs drives' }));
    expect(mocks.push).toHaveBeenCalledWith('/orgs/org_nw/drives');
    picker.unmount();

    // The lapse banner is the read-only notice, with nothing to pay.
    mocks.pathname = '/dashboard/d-product/p1';
    const banner = wrap(<OrgSurfaceBanner />);
    expect(screen.getByText('Northwind Labs is read-only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).toBeNull();
    banner.unmount();

    // The drive's Organization card is read-only.
    const card = wrap(<OrgDriveCard drive={product} leadName="Priya" onChanged={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Open/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Drive lead' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move out/ })).toBeNull();
    card.unmount();

    // The drive Wallet page is the consumer view: no pool, no allocation, no one else's spend.
    const wallet = wrap(<DriveWalletSettingsPage />);
    for (const id of ['wallet-rules-card', 'wallet-caps-card', 'wallet-spend-card', 'wallet-pool-line']) expect(screen.queryByTestId(id)).toBeNull();
    for (const secret of ['900,017', '64,513', 'Other Person', '120,000']) expect(wallet.container.innerHTML).not.toContain(secret);
  });
});
