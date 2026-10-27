/**
 * The shell is the one place that decides which footer a sidebar gets, and
 * it decides from the focus. Four variants used to make that call themselves.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let params: { driveId?: string } = {};
vi.mock('next/navigation', () => ({
  useParams: () => params,
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/layout/navbar/DriveSwitcher', () => ({ default: () => <div data-testid="switcher" /> }));
vi.mock('../PrimaryNavigation', () => ({
  default: ({ driveId }: { driveId?: string }) => <nav data-testid="nav" data-drive={driveId ?? ''} />,
}));
vi.mock('../DriveFooter', () => ({ default: () => <div data-testid="drive-footer" /> }));
vi.mock('../DashboardFooter', () => ({ default: () => <div data-testid="dashboard-footer" /> }));

import SidebarShell from '../SidebarShell';

describe('SidebarShell', () => {
  it('given All drives, should render the dashboard footer around the body', () => {
    params = {};
    render(<SidebarShell><div data-testid="body" /></SidebarShell>);

    expect(screen.getByTestId('switcher')).toBeInTheDocument();
    expect(screen.getByTestId('nav')).toHaveAttribute('data-drive', '');
    expect(screen.getByTestId('body')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-footer')).toBeInTheDocument();
    expect(screen.queryByTestId('drive-footer')).not.toBeInTheDocument();
  });

  it('given a drive, should render that drive\'s footer and hand the nav the drive', () => {
    params = { driveId: 'drive_eng' };
    render(<SidebarShell><div /></SidebarShell>);

    expect(screen.getByTestId('nav')).toHaveAttribute('data-drive', 'drive_eng');
    expect(screen.getByTestId('drive-footer')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-footer')).not.toBeInTheDocument();
  });
});
