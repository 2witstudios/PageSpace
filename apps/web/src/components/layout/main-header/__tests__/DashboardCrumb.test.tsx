import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Drive } from '@pagespace/lib/types';

import { useParams, usePathname } from 'next/navigation';
import DashboardCrumb from '../DashboardCrumb';
import { useDriveStore } from '@/hooks/useDrive';

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({})),
  usePathname: vi.fn(() => '/dashboard'),
}));

const buildDrive = (overrides: Partial<Drive> = {}): Drive => ({
  id: 'drive_eng',
  name: 'Engineering',
  slug: 'engineering',
  ownerId: 'user_1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  ...overrides,
});

/** Put the component on a route, the way Next would. */
const atRoute = (pathname: string, params: Record<string, string | string[]> = {}) => {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useParams).mockReturnValue(params);
};

describe('DashboardCrumb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDriveStore.setState({ drives: [], currentDriveId: null, isLoading: false, lastFetched: 0 });
  });

  describe('on the dashboard itself', () => {
    it('given the dashboard route, should name the dashboard as the current page rather than link to it', () => {
      atRoute('/dashboard');

      render(<DashboardCrumb />);

      const marker = screen.getByText('Dashboard');
      expect(marker).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  describe('inside a drive', () => {
    it('given a drive route, should offer a link out to the dashboard', () => {
      atRoute('/dashboard/drive_eng/page_1', { driveId: 'drive_eng' });

      render(<DashboardCrumb />);

      expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
    });

    it('given a loaded drive, should name the drive you are standing in', () => {
      atRoute('/dashboard/drive_eng/page_1', { driveId: 'drive_eng' });
      useDriveStore.setState({ drives: [buildDrive()] });

      render(<DashboardCrumb />);

      expect(screen.getByText('Engineering')).toBeInTheDocument();
    });

    it('given the drive has not loaded yet, should still link out and simply omit the drive name', () => {
      atRoute('/dashboard/drive_eng/page_1', { driveId: 'drive_eng' });

      render(<DashboardCrumb />);

      expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
      expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
    });

    it('given a catch-all driveId param, should read the first segment', () => {
      atRoute('/dashboard/drive_eng/page_1', { driveId: ['drive_eng', 'page_1'] });
      useDriveStore.setState({ drives: [buildDrive()] });

      render(<DashboardCrumb />);

      expect(screen.getByText('Engineering')).toBeInTheDocument();
    });
  });

  describe('on a dashboard sibling route', () => {
    // /dashboard/dms and its ten static siblings carry no driveId while still
    // being somewhere you need a way out of. Keying the current-page marker off
    // the driveId instead of the pathname strands the user on every one of them.
    it.each([
      ['/dashboard/dms'],
      ['/dashboard/tasks'],
      ['/dashboard/calendar'],
    ])('given %s, should still offer a link out rather than a dead marker', (pathname) => {
      atRoute(pathname);

      render(<DashboardCrumb />);

      const link = screen.getByRole('link', { name: 'Dashboard' });
      expect(link).toHaveAttribute('href', '/dashboard');
      expect(link).not.toHaveAttribute('aria-current');
    });
  });

  describe('accessible name', () => {
    it('given the link variant, should take its name from the visible text with no aria-label overriding it', () => {
      atRoute('/dashboard/drive_eng', { driveId: 'drive_eng' });

      render(<DashboardCrumb />);

      expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-label');
    });
  });
});
