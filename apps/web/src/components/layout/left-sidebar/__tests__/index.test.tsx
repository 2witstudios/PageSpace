/**
 * The drive + button must render from the server-computed effective
 * permission (drive.canCreatePages), never from a manage-tier role check
 * (#2627). A plain MEMBER with create access gets an enabled + button;
 * view-only custom roles and stale persisted DTOs fail closed to the lock.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Drive } from '@pagespace/lib/types';

let focusedDriveId: string | null = 'd1';
let drives: Drive[] = [];
const openQuickCreate = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));
vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (selector: (state: unknown) => unknown) =>
    selector({ drives, fetchDrives: vi.fn() }),
}));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({ openQuickCreate }),
}));
vi.mock('@/lib/dashboard/focus', () => ({
  focusDriveId: () => focusedDriveId,
  useFocus: () => ({}),
}));
vi.mock('../SidebarShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../DashboardSidebar', () => ({
  default: () => <div data-testid="dashboard-sidebar" />,
}));
vi.mock('../page-tree/PageTree', () => ({
  default: () => <div data-testid="page-tree" />,
}));

import Sidebar from '../index';

function makeDrive(overrides: Partial<Drive> & { id: string }): Drive {
  return {
    name: 'Drive',
    slug: 'drive',
    ownerId: 'other_user',
    isOwned: false,
    role: 'MEMBER',
    isTrashed: false,
    trashedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Drive;
}

describe('Sidebar + button permission gate (#2627)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focusedDriveId = 'd1';
    drives = [];
  });

  it('given a MEMBER whose drive grants create (canCreatePages true), should show the enabled + button and no lock', () => {
    drives = [makeDrive({ id: 'd1', role: 'MEMBER', canCreatePages: true })];
    render(<Sidebar />);

    const create = screen.getByRole('button', { name: 'Create new page' });
    expect(create).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Create page locked' })).not.toBeInTheDocument();
  });

  it('given a view-only member (canCreatePages false), should show the disabled lock and no + button', () => {
    drives = [makeDrive({ id: 'd1', role: 'MEMBER', canCreatePages: false })];
    render(<Sidebar />);

    const locked = screen.getByRole('button', { name: 'Create page locked' });
    expect(locked).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Create new page' })).not.toBeInTheDocument();
  });

  it('given a persisted drive DTO predating canCreatePages, should fail closed to the lock', () => {
    drives = [makeDrive({ id: 'd1', role: 'ADMIN' })];
    render(<Sidebar />);

    expect(screen.getByRole('button', { name: 'Create page locked' })).toBeDisabled();
  });

  it('given no focused drive (dashboard view), should render neither create affordance', () => {
    focusedDriveId = null;
    render(<Sidebar />);

    expect(screen.queryByRole('button', { name: 'Create new page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create page locked' })).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
  });
});
