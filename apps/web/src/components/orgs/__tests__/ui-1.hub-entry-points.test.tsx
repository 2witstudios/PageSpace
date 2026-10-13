/**
 * UI-1 in one place: the org settings hub at /orgs/[orgId]/settings renders its rows with the shared
 * SettingsRow, and each of its three entry points links to it — the picker's org group, Account
 * Settings › Organizations, and the Organization card on a drive's General page.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drive } from '@pagespace/lib/types';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
const NORTHWIND = { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, role: 'ADMIN' as const, lapsed: false };

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ orgId: 'org_nw' }),
  usePathname: () => '/dashboard',
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ members: [] }), { status: 200 })),
}));
vi.mock('@/components/layout/left-sidebar/CreateDriveDialog', () => ({ default: () => null }));
vi.mock('../CreateOrganizationDialog', () => ({ CreateOrganizationDialog: () => null }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/hooks/useDriveWallet', () => ({ useDriveWallet: () => ({ wallet: null }) }));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ organizations: [NORTHWIND], orgById: (id: string | null | undefined) => (id === NORTHWIND.id ? NORTHWIND : null), refresh: vi.fn() }),
}));
vi.mock('@/hooks/useOrgs', () => ({
  useMyOrgs: () => ({ orgs: [NORTHWIND], isLoading: false, mutate: vi.fn() }),
  useOrgRealtime: vi.fn(),
  useOrg: () => ({ org: { organization: { ...NORTHWIND, ownerId: 'u_owner', createdAt: '2026-09-01T00:00:00Z' }, viewer: { userId: 'u_me', role: 'ADMIN' } }, isLoading: false, mutate: vi.fn() }),
  useOrgHubCounts: () => ({ members: 12, drives: 6 }),
  useOrgSeats: () => ({ data: undefined }),
}));

import DriveSwitcherDialog from '@/components/layout/navbar/DriveSwitcherDialog';
import { AccountOrganizationsSection } from '../AccountOrganizationsSection';
import { OrgDriveCard } from '@/components/drives/OrgDriveCard';
import OrgSettingsPage from '@/app/orgs/[orgId]/settings/page';
import { useDriveStore } from '@/hooks/useDrive';
import { useFavorites } from '@/hooks/useFavorites';

const product: Drive = {
  id: 'd-product', name: 'Product', slug: 'product', ownerId: 'u-me', isTrashed: false, trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, orgId: 'org_nw', orgVisibility: 'OPEN',
};
const HUB = '/orgs/org_nw/settings';

beforeEach(() => {
  vi.clearAllMocks();
  useDriveStore.setState({ drives: [product], currentDriveId: null, isLoading: false, lastFetched: Date.now() });
  useFavorites.setState({ driveIds: new Set(), pageIds: new Set(), favorites: [], isSynced: true, isLoading: false, addFavorite: vi.fn(async () => {}), removeFavorite: vi.fn(async () => {}) });
});

describe('the org settings hub and the ways to it', () => {
  it('UI-1 the hub at /orgs/[orgId]/settings lists SettingsRow rows, and the picker\'s org header, Account Settings › Organizations and the drive General Organization card each lead there', () => {
    // The hub: SettingsRow rows linking under the hub path.
    const hub = render(<OrgSettingsPage />);
    const general = screen.getByRole('link', { name: /General/ });
    expect(general.getAttribute('href')).toBe(`${HUB}/general`);
    expect((general.firstElementChild as HTMLElement).className).toContain('hover:text-accent-foreground');
    hub.unmount();

    // 1. The picker's org header (icon) and its keyboard option.
    const picker = render(<DriveSwitcherDialog open onOpenChange={vi.fn()} />);
    const header = screen.getByTestId('picker-group-org');
    expect(within(header).getByRole('link', { name: 'Northwind Labs settings', hidden: true }).getAttribute('href')).toBe(HUB);
    fireEvent.click(screen.getByRole('option', { name: 'Northwind Labs settings' }));
    expect(mocks.push).toHaveBeenCalledWith(HUB);
    picker.unmount();

    // 2. Account Settings › Organizations.
    const account = render(<AccountOrganizationsSection />);
    expect(screen.getByRole('link', { name: /Northwind Labs/ }).getAttribute('href')).toBe(HUB);
    account.unmount();

    // 3. The Organization card on the drive's General page.
    render(<SWRConfig value={{ provider: () => new Map() }}><OrgDriveCard drive={product} leadName="Me" onChanged={vi.fn()} /></SWRConfig>);
    expect(screen.getByRole('link', { name: /Org settings/ }).getAttribute('href')).toBe(HUB);
  });
});
