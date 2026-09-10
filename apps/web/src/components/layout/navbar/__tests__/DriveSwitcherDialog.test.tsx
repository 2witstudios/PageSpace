/**
 * The drive picker is a dialog now, not a dropdown. These tests pin what it
 * OFFERS (three groups, two actions, a star, a current-drive mark) and what
 * choosing does (navigate, close, bump recency), against the real cmdk
 * dialog rendered in jsdom.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drive } from '@pagespace/lib/types';

const push = vi.fn();
let pathname = '/dashboard';
// The route is what makes a drive "current" in the picker; the store's
// currentDriveId is only a sidebar-synced mirror of it.
let params: { driveId?: string } = { driveId: 'k3xq9w2p7m' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => params,
  usePathname: () => pathname,
}));

const fetchWithAuth = vi.fn((..._args: unknown[]) => Promise.resolve(new Response(null, { status: 200 })));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  post: vi.fn(),
  del: vi.fn(),
}));

const createDialogSpy = vi.fn();
vi.mock('@/components/layout/left-sidebar/CreateDriveDialog', () => ({
  default: ({ isOpen }: { isOpen: boolean }) => {
    createDialogSpy(isOpen);
    return isOpen ? <div data-testid="create-drive-dialog" /> : null;
  },
}));

import DriveSwitcherDialog from '../DriveSwitcherDialog';
import { useDriveStore } from '@/hooks/useDrive';
import { useFavorites } from '@/hooks/useFavorites';

const buildDrive = (overrides: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: 'user_1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  ...overrides,
});

const drives: Drive[] = [
  buildDrive({ id: 'k3xq9w2p7m', name: 'Coffee Co.', lastAccessedAt: '2026-09-09T10:00:00.000Z' }),
  buildDrive({ id: 'v8n1t6zr4c', name: 'Engineering', lastAccessedAt: '2026-09-08T10:00:00.000Z' }),
  buildDrive({ id: 'h2s7d0yb5j', name: 'Marketing', lastAccessedAt: '2026-09-01T10:00:00.000Z' }),
  buildDrive({ id: 'q4f9l3mx8a', name: 'Old Stuff', isTrashed: true }),
];

const renderPicker = (onOpenChange = vi.fn()) => {
  render(<DriveSwitcherDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
};

const group = (heading: string | RegExp) => {
  const headingEl = screen.getByText(heading);
  // cmdk: heading lives inside [cmdk-group]
  const groupEl = headingEl.closest('[cmdk-group]');
  if (!groupEl) throw new Error(`no cmdk group for ${String(heading)}`);
  return within(groupEl as HTMLElement);
};

describe('DriveSwitcherDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathname = '/dashboard/k3xq9w2p7m';
    params = { driveId: 'k3xq9w2p7m' };
    useDriveStore.setState({ drives, currentDriveId: 'k3xq9w2p7m', isLoading: false, lastFetched: 0 });
    useFavorites.setState({
      driveIds: new Set(['k3xq9w2p7m']),
      pageIds: new Set(),
      favorites: [],
      isSynced: true,
      isLoading: false,
      addFavorite: vi.fn(async () => {}),
      removeFavorite: vi.fn(async () => {}),
    });
  });

  describe('what it offers', () => {
    it('given favorites and recents, should list Favorites, Recent, and All drives without the trash', () => {
      renderPicker();

      expect(group('Favorites').getByText('Coffee Co.')).toBeInTheDocument();
      expect(group('Recent').getByText('Engineering')).toBeInTheDocument();
      expect(group('Recent').queryByText('Coffee Co.')).not.toBeInTheDocument();
      expect(group(/All drives · 3/).getByText('Marketing')).toBeInTheDocument();
      expect(screen.queryByText('Old Stuff')).not.toBeInTheDocument();
    });

    it('given a current drive, should mark it rather than describe it', () => {
      renderPicker();

      const row = group('Favorites').getByText('Coffee Co.').closest('[cmdk-item]') as HTMLElement;
      expect(row.getAttribute('data-current')).toBe('true');
      // The state lives in the option's accessible name, because nothing inside
      // a cmdk row is a separate control to assistive tech.
      expect(row).toHaveAttribute('aria-label', 'Coffee Co., current drive, favorite');
      expect(screen.queryByText('current')).not.toBeInTheDocument();
    });

    it('given the actions bar, should offer Create drive above the list, outside it', () => {
      renderPicker();

      const create = screen.getByRole('button', { name: 'Create drive' });
      expect(create.closest('[cmdk-list]')).toBeNull();
    });

    it('given the list, should offer All drives as its first row, unmarked while a drive is current', () => {
      renderPicker();

      const rows = screen.getAllByRole('option');
      expect(rows[0]).toHaveAttribute('aria-label', 'All drives');
      expect(rows[0].getAttribute('data-current')).toBeNull();
    });

    it('given a route with no drive, should mark All drives as current even if the store still remembers one', () => {
      pathname = '/dashboard/tasks';
      params = {};
      renderPicker();

      // The store still says Coffee Co.; the route wins, so no row is current.
      expect(screen.queryAllByRole('option', { name: /current drive/ })).toHaveLength(0);

      const all = screen.getByRole('option', { name: 'All drives, current' });
      expect(all.getAttribute('data-current')).toBe('true');
      expect(all).toHaveAttribute('aria-current', 'true');
    });
  });

  describe('on a phone', () => {
    // jsdom applies no media queries, so this pins the mechanism: the phone
    // placement is measured from the safe-area insets, not the screen edge.
    // The header pads the same inset, and in the iOS app it is a real notch.
    it('given the phone layout classes, should anchor below the top inset and stop above the bottom one', () => {
      renderPicker();

      const content = screen.getByRole('dialog').className;
      expect(content).toMatch(/max-sm:top-\[calc\(var\(--safe-area-top\)\+0\.75rem\)\]/);
      expect(content).toMatch(/max-sm:max-h-\[calc\(100dvh-var\(--safe-area-top\)-var\(--safe-area-bottom\)-1\.5rem\)\]/);
      expect(content).toMatch(/max-sm:translate-y-0/);
    });
  });

  describe('searching', () => {
    it('given a query, should filter every group and drop Recent, whose order means nothing under a query', async () => {
      // Fixture ids are opaque on purpose: cmdk's own filter matches on item
      // VALUE (group:id), so with `shouldFilter` left on it would hide every
      // row our name filter kept. Ids that happened to contain the name
      // fragment masked exactly that in the first cut of this file.
      renderPicker();

      await userEvent.type(screen.getByPlaceholderText('Search drives…'), 'engineering');

      expect(screen.queryByText('Recent')).not.toBeInTheDocument();
      expect(group('Results').getByText('Engineering')).toBeInTheDocument();
      expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
      expect(screen.queryByText('Coffee Co.')).not.toBeInTheDocument();
    });

    it('given a query nothing matches, should say so', async () => {
      renderPicker();

      await userEvent.type(screen.getByPlaceholderText('Search drives…'), 'zzz');

      expect(screen.getByText('No drives match.')).toBeInTheDocument();
    });
  });

  describe('choosing', () => {
    it('given a drive is picked, should navigate to it, record the visit, and close', async () => {
      const { onOpenChange } = renderPicker();

      await userEvent.click(group('Recent').getByText('Engineering'));

      expect(push).toHaveBeenCalledWith('/dashboard/v8n1t6zr4c');
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/drives/v8n1t6zr4c/access', { method: 'POST' });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(useDriveStore.getState().currentDriveId).toBe('v8n1t6zr4c');
    });

    it('given a star is tapped, should toggle the favorite and NOT switch drive', async () => {
      const { onOpenChange } = renderPicker();
      const addFavorite = useFavorites.getState().addFavorite;

      const row = group('Recent').getByText('Engineering').closest('[cmdk-item]') as HTMLElement;
      await userEvent.click(within(row).getByTestId('favorite-toggle'));

      expect(addFavorite).toHaveBeenCalledWith('v8n1t6zr4c', 'drive');
      expect(push).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('given Shift+Enter on the highlighted row, should toggle its favorite from the keyboard and NOT switch drive', async () => {
      // The star is pointer-only; this is the path a keyboard or screen-reader
      // user has, and the one the hint footer names.
      const { onOpenChange } = renderPicker();
      const addFavorite = useFavorites.getState().addFavorite;
      const input = screen.getByPlaceholderText('Search drives…');

      await userEvent.type(input, 'marketing');
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');

      expect(addFavorite).toHaveBeenCalledWith('h2s7d0yb5j', 'drive');
      expect(push).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('given All drives from a drive section, should keep the section, clear the current drive, and close', async () => {
      pathname = '/dashboard/k3xq9w2p7m/tasks';
      const { onOpenChange } = renderPicker();

      await userEvent.click(screen.getByRole('option', { name: 'All drives' }));

      expect(push).toHaveBeenCalledWith('/dashboard/tasks');
      expect(useDriveStore.getState().currentDriveId).toBeNull();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      pathname = '/dashboard';
    });

    it('given All drives from a page inside a drive, should go home', async () => {
      pathname = '/dashboard/k3xq9w2p7m/page_1';
      renderPicker();

      await userEvent.click(screen.getByRole('option', { name: 'All drives' }));

      expect(push).toHaveBeenCalledWith('/dashboard');
    });

    it('given any query, Enter should pick the typed drive, with All drives moved below the results', async () => {
      renderPicker();

      const input = screen.getByPlaceholderText('Search drives…');
      // A one-letter query matches "all drives" too; the row must still not be first.
      await userEvent.type(input, 'e');
      let rows = screen.getAllByRole('option');
      expect(rows[0].getAttribute('aria-label')).not.toMatch(/^All drives/);
      expect(rows[rows.length - 1]).toHaveAttribute('aria-label', 'All drives');

      await userEvent.clear(input);
      await userEvent.type(input, 'mark');
      rows = screen.getAllByRole('option');
      expect(rows[0].getAttribute('aria-label')).toMatch(/^Marketing/);
      await userEvent.keyboard('{Enter}');

      expect(push).toHaveBeenCalledWith('/dashboard/h2s7d0yb5j');
      expect(push).not.toHaveBeenCalledWith('/dashboard');
    });

    it('given the focus you are already in, should close without navigating', async () => {
      pathname = '/dashboard/dms/thread_1';
      params = {};
      const { onOpenChange } = renderPicker();

      await userEvent.click(screen.getByRole('option', { name: 'All drives, current' }));

      expect(push).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('given Shift+Enter while All drives is highlighted, should do nothing rather than navigate', async () => {
      const { onOpenChange } = renderPicker();

      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');

      expect(push).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('given Create drive, should hand off to the create dialog', async () => {
      const { onOpenChange } = renderPicker();

      await userEvent.click(screen.getByRole('button', { name: 'Create drive' }));

      expect(screen.getByTestId('create-drive-dialog')).toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
