/**
 * ORG-2: "A user in no org sees no org UI." Ruling for this lane (to record as a decision): the
 * create-organization entry in Account Settings is the ONE org affordance a no-org user sees —
 * UI-6 needs a way in. Everything else is absent: no picker grouping or org header, no
 * Organization card on a drive, no org crumb, no org settings link anywhere, and no owner choice
 * when creating a drive. Every surface is rendered with orgs switched on and the person's org
 * list empty, so the absence is the no-org rule, not the dark flag.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drive } from '@pagespace/lib/types';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ driveId: 'd-notes' }),
  usePathname: () => '/dashboard/d-notes',
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()),
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ members: [] }), { status: 200 })),
  post: vi.fn(),
}));
// The person belongs to no organization: both org hooks answer an empty list.
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ organizations: [], orgById: () => null }),
}));
vi.mock('@/hooks/useOrgs', () => ({ useMyOrgs: () => ({ orgs: [], isLoading: false }), useOrgRealtime: vi.fn() }));
vi.mock('@/hooks/useDriveWallet', () => ({ useDriveWallet: () => ({ wallet: null }) }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('../CreateOrganizationDialog', () => ({ CreateOrganizationDialog: () => null }));

import DriveSwitcherDialog from '@/components/layout/navbar/DriveSwitcherDialog';
import DashboardCrumb from '@/components/layout/main-header/DashboardCrumb';
import CreateDriveDialog from '@/components/layout/left-sidebar/CreateDriveDialog';
import { OrgDriveCard } from '@/components/drives/OrgDriveCard';
import { AccountOrganizationsSection } from '../AccountOrganizationsSection';
import { useDriveStore } from '@/hooks/useDrive';
import { useFavorites } from '@/hooks/useFavorites';

const drive = (o: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: o.name.toLowerCase(), ownerId: 'u-me', isTrashed: false, trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, orgId: null, ...o,
});
const myDrives = [drive({ id: 'd-home', name: 'Home' }), drive({ id: 'd-notes', name: 'Notes' })];

const orgLinks = () => screen.queryAllByRole('link').filter((link) => (link.getAttribute('href') ?? '').startsWith('/orgs'));

beforeEach(() => {
  useDriveStore.setState({ drives: myDrives, currentDriveId: 'd-notes', isLoading: false, lastFetched: Date.now() });
  useFavorites.setState({ driveIds: new Set(), pageIds: new Set(), favorites: [], isSynced: true, isLoading: false, addFavorite: vi.fn(async () => {}), removeFavorite: vi.fn(async () => {}) });
});

describe('ORG-2 (partial) a user in no org sees no org UI (the server side, an empty org list and 404s, is org-roles-many-orgs.integration)', () => {
  it('the drive picker is not grouped by owner and has no org header or org settings link', () => {
    render(<DriveSwitcherDialog open onOpenChange={vi.fn()} />);
    expect(screen.getAllByText('Notes').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('picker-group-org')).toBeNull();
    expect(screen.queryByRole('option', { name: / settings$/ })).toBeNull();
    expect(orgLinks()).toEqual([]);
  });

  it('a drive shows no Organization card and the header crumb names no org', () => {
    const { container } = render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <OrgDriveCard drive={myDrives[1]} leadName="Me" onChanged={vi.fn()} />
      </SWRConfig>,
    );
    expect(container.innerHTML).toBe('');
    render(<DashboardCrumb />);
    expect(orgLinks()).toEqual([]);
  });

  it('creating a drive offers no owner choice: it is personal', () => {
    render(<CreateDriveDialog isOpen setIsOpen={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Owner' })).toBeNull();
  });

  it('Account Settings shows only the Create organization entry: no organization listed, no hub link', () => {
    render(<AccountOrganizationsSection />);
    expect(screen.getByRole('button', { name: /Create organization/ })).toBeTruthy();
    expect(orgLinks()).toEqual([]);
  });
});
