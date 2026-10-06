import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drive } from '@pagespace/lib/types';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({}), usePathname: () => '/dashboard' }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))), post: vi.fn(), del: vi.fn() }));
vi.mock('@/components/layout/left-sidebar/CreateDriveDialog', () => ({ default: () => null }));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ organizations: [{ id: 'o-northwind', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, role: 'MEMBER' }] }),
}));

import DriveSwitcherDialog from '../DriveSwitcherDialog';
import { useDriveStore } from '@/hooks/useDrive';
import { useFavorites } from '@/hooks/useFavorites';

const drive = (o: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: o.name.toLowerCase(), ownerId: 'u1', isTrashed: false, trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: false, ...o,
});

// The store holds exactly what GET /api/drives answered: the accessible list. An un-joined
// RESTRICTED drive (Finance) is not in it, so the picker cannot show it (A-4, DRV-6).
const accessible: Drive[] = [
  drive({ id: 'd-product', name: 'Product', orgId: 'o-northwind', orgVisibility: 'OPEN' }),
  drive({ id: 'd-research', name: 'Customer Research', orgId: 'o-northwind', orgVisibility: 'RESTRICTED' }),
  drive({ id: 'd-home', name: 'Home', orgId: null, isOwned: true }),
];

describe('DriveSwitcherDialog with organizations', () => {
  beforeEach(() => {
    useDriveStore.setState({ drives: accessible, currentDriveId: null, isLoading: false, lastFetched: Date.now() });
    useFavorites.setState({ driveIds: new Set(), pageIds: new Set(), favorites: [], isSynced: true, isLoading: false, addFavorite: vi.fn(async () => {}), removeFavorite: vi.fn(async () => {}) });
  });

  it('DRV-9 (partial) groups drives under the org header (with a settings link) and a Personal group, from the same accessible list', () => {
    render(<DriveSwitcherDialog open onOpenChange={vi.fn()} />);
    const org = screen.getByTestId('picker-group-org');
    expect(org.textContent).toContain('Northwind Labs');
    expect(org.textContent).toContain('· 2');
    expect(within(org).getByRole('link', { name: 'Northwind Labs settings', hidden: true }).getAttribute('href')).toBe('/orgs/o-northwind/settings');
    const orgGroup = within(org.closest('[cmdk-group]') as HTMLElement);
    expect(orgGroup.getByText('Product')).toBeTruthy();
    expect(orgGroup.getByText('Customer Research')).toBeTruthy();
    const personal = within(screen.getByTestId('picker-group-personal').closest('[cmdk-group]') as HTMLElement);
    expect(personal.getByText('Home')).toBeTruthy();
    expect(screen.queryByText(/All drives ·/)).toBeNull();
  });

  it('UI-1 (partial) the org hub is reachable from the picker by keyboard and assistive tech: a "settings" option in the org group, not only the icon in its hidden heading', () => {
    const onOpenChange = vi.fn();
    render(<DriveSwitcherDialog open onOpenChange={onOpenChange} />);
    const option = screen.getByRole('option', { name: 'Northwind Labs settings' });
    expect(option.closest('[cmdk-group]')).toBe(screen.getByTestId('picker-group-org').closest('[cmdk-group]'));
    fireEvent.click(option);
    expect(push).toHaveBeenCalledWith('/orgs/o-northwind/settings');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('DRV-9 (partial) shows nothing the person cannot open: an un-joined Restricted drive is never listed', () => {
    render(<DriveSwitcherDialog open onOpenChange={vi.fn()} />);
    expect(screen.queryByText('Finance')).toBeNull();
    // Every option but the way out (All drives) and an org's settings is a drive.
    const listed = screen.getAllByRole('option').map((o) => o.textContent ?? '').filter((t) => !/ settings$/.test(t));
    expect(listed.filter((t) => /Product|Customer Research|Home/.test(t)).length).toBe(listed.filter((t) => !/All drives/.test(t)).length);
  });
});
