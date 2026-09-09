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

    it('given a drive name long enough to truncate, should keep the full name recoverable on hover', () => {
      atRoute('/dashboard/drive_eng/page_1', { driveId: 'drive_eng' });
      useDriveStore.setState({ drives: [buildDrive({ name: 'Q3 Platform Migration Programme' })] });

      render(<DashboardCrumb />);

      expect(screen.getByText('Q3 Platform Migration Programme')).toHaveAttribute(
        'title',
        'Q3 Platform Migration Programme',
      );
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

  describe('below sm', () => {
    // jsdom applies no media queries, so this asserts the MECHANISM rather than
    // the rendered result. It is here because "the word survives, the crumb
    // goes" is a deliberate decision about the reported bug — dropping to a
    // bare glyph on the narrowest screen would rebuild it where guessing is
    // hardest — and nothing else in the suite would notice that being undone.
    it('given a loaded drive, should gate only the crumb on the sm breakpoint and never the label', () => {
      atRoute('/dashboard/drive_eng/page_1', { driveId: 'drive_eng' });
      useDriveStore.setState({ drives: [buildDrive()] });

      render(<DashboardCrumb />);

      const crumb = screen.getByText('Engineering').parentElement;
      expect(crumb?.className).toMatch(/\bhidden\b/);
      expect(crumb?.className).toMatch(/\bsm:flex\b/);

      const label = screen.getByRole('link', { name: 'Dashboard' });
      expect(label.className).not.toMatch(/\bhidden\b/);
    });

    // The way OUT always shows; the you-are-here marker does not. At 390px the
    // left group has ~146px once the trailing controls are counted, and the nav
    // toggle plus search button claim ~88px — so a control that refuses to
    // shrink overflows into those controls rather than tightening. The marker
    // can afford to go because it has nowhere to navigate to; the link cannot.
    it('given the dashboard route, should gate the you-are-here marker on sm while the link variant never hides', () => {
      atRoute('/dashboard');
      const { unmount } = render(<DashboardCrumb />);
      expect(screen.getByText('Dashboard').className).toMatch(/\bhidden\b/);
      unmount();

      atRoute('/dashboard/drive_eng', { driveId: 'drive_eng' });
      render(<DashboardCrumb />);
      expect(screen.getByRole('link', { name: 'Dashboard' }).className).not.toMatch(/\bhidden\b/);
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
