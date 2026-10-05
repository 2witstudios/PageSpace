import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Drive } from '@pagespace/lib/types';
import { useParams, usePathname } from 'next/navigation';
import { useDriveStore } from '@/hooks/useDrive';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('next/navigation', () => ({ useParams: vi.fn(() => ({})), usePathname: vi.fn(() => '/dashboard') }));
vi.mock('@/components/layout/navbar/DriveSwitcherDialog', () => ({ default: () => null }));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ orgById: (id: string | null) => (id === 'o-northwind' ? { id, name: 'Northwind Labs', avatarUrl: null } : null) }),
}));

import DashboardCrumb from '../DashboardCrumb';

const drive = (overrides: Partial<Drive>): Drive => ({
  id: 'd-product', name: 'Product', slug: 'product', ownerId: 'u1', isTrashed: false, trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isOwned: true, ...overrides,
});

describe('DashboardCrumb in an org-owned drive', () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue('/dashboard/d-product/p1');
    vi.mocked(useParams).mockReturnValue({ driveId: 'd-product' });
  });

  it('UI-3 the crumb stays ONE chip for an org drive: the org\'s mark and the drive\'s name, the org named only in its tooltip', () => {
    useDriveStore.setState({ drives: [drive({ orgId: 'o-northwind' })], currentDriveId: null, isLoading: false, lastFetched: 0 });
    render(<DashboardCrumb />);
    const chips = screen.getAllByRole('button');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('NProduct');
    expect(screen.getByTitle('Product · Northwind Labs')).toBeTruthy();
    expect(screen.queryByText('Northwind Labs')).toBeNull();
  });

  it('UI-3 a personal drive keeps its folder chip, unchanged', () => {
    useDriveStore.setState({ drives: [drive({ orgId: null })], currentDriveId: null, isLoading: false, lastFetched: 0 });
    render(<DashboardCrumb />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByTitle('Product')).toBeTruthy();
  });
});
