import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Drive } from '@pagespace/lib/types';

import { DriveScopeSwitcher, driveSectionHref, globalSectionHref } from '../DriveScopeSwitcher';
import { useDriveStore } from '@/hooks/useDrive';

// The switcher asks the store to (re)load drives on mount. With an empty
// store that is a real fetch, which jsdom cannot make; the tests seed the
// store directly, so the network never matters here.
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => [] })),
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

const seedDrives = (drives: Drive[]) => {
  // lastFetched = now so the component's fetchDrives() call is a cache hit
  // and never touches the network.
  useDriveStore.setState({ drives, currentDriveId: null, isLoading: false, lastFetched: Date.now() });
};

describe('DriveScopeSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedDrives([]);
  });

  describe('hrefs', () => {
    it('given each section, should map the global view to the same route the sidebar uses', () => {
      expect(globalSectionHref('channels')).toBe('/dashboard/channels');
      expect(globalSectionHref('files')).toBe('/dashboard/drives');
      expect(globalSectionHref('tasks')).toBe('/dashboard/tasks');
      expect(globalSectionHref('calendar')).toBe('/dashboard/calendar');
    });

    it('given a drive, should nest the section under that drive', () => {
      expect(driveSectionHref('calendar', 'drive_eng')).toBe('/dashboard/drive_eng/calendar');
    });
  });

  describe('inside a drive', () => {
    it('given a known drive, should name it on the trigger', () => {
      seedDrives([buildDrive()]);

      render(<DriveScopeSwitcher section="tasks" driveId="drive_eng" />);

      expect(screen.getByRole('button', { name: /Engineering/ })).toBeInTheDocument();
    });

    it('given a drive the store has not loaded, should still render a usable trigger', () => {
      render(<DriveScopeSwitcher section="tasks" driveId="drive_missing" />);

      expect(screen.getByRole('button', { name: /This drive/ })).toBeInTheDocument();
    });

    it('given the menu is open, should offer the global view and every other drive', async () => {
      const user = userEvent.setup();
      seedDrives([
        buildDrive(),
        buildDrive({ id: 'drive_design', name: 'Design', slug: 'design' }),
        buildDrive({ id: 'drive_gone', name: 'Old', slug: 'old', isTrashed: true }),
      ]);

      render(<DriveScopeSwitcher section="tasks" driveId="drive_eng" />);
      await user.click(screen.getByRole('button', { name: /Engineering/ }));

      const allDrives = await screen.findByRole('menuitem', { name: /All drives/ });
      expect(allDrives).toHaveAttribute('href', '/dashboard/tasks');

      const design = screen.getByRole('menuitem', { name: /Design/ });
      expect(design).toHaveAttribute('href', '/dashboard/drive_design/tasks');

      const current = screen.getByRole('menuitem', { name: /Engineering/ });
      expect(current).toHaveAttribute('aria-current', 'page');

      expect(screen.queryByRole('menuitem', { name: /Old/ })).not.toBeInTheDocument();
    });
  });

  describe('on the global view', () => {
    it('given no drive, should say so on the trigger and mark the global entry current', async () => {
      const user = userEvent.setup();
      seedDrives([buildDrive()]);

      render(<DriveScopeSwitcher section="files" />);
      const trigger = screen.getByRole('button', { name: /All drives/ });
      await user.click(trigger);

      const allDrives = await screen.findByRole('menuitem', { name: /All drives/ });
      expect(allDrives).toHaveAttribute('aria-current', 'page');
      expect(allDrives).toHaveAttribute('href', '/dashboard/drives');

      expect(screen.getByRole('menuitem', { name: /Engineering/ })).toHaveAttribute(
        'href',
        '/dashboard/drive_eng/files'
      );
    });

    it('given compact mode, should keep the scope in the accessible name', () => {
      render(<DriveScopeSwitcher section="calendar" compact />);

      expect(screen.getByRole('button', { name: /across all drives/ })).toBeInTheDocument();
    });
  });
});
