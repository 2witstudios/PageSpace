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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({}),
  usePathname: () => '/dashboard',
}));

const fetchWithAuth = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
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

import DrivePickerDialog from '../DrivePickerDialog';
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
  buildDrive({ id: 'drive_coffee', name: 'Coffee Co.', lastAccessedAt: '2026-09-09T10:00:00.000Z' }),
  buildDrive({ id: 'drive_eng', name: 'Engineering', lastAccessedAt: '2026-09-08T10:00:00.000Z' }),
  buildDrive({ id: 'drive_mkt', name: 'Marketing', lastAccessedAt: '2026-09-01T10:00:00.000Z' }),
  buildDrive({ id: 'drive_trash', name: 'Old Stuff', isTrashed: true }),
];

const renderPicker = (onOpenChange = vi.fn()) => {
  render(<DrivePickerDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
};

const group = (heading: string | RegExp) => {
  const headingEl = screen.getByText(heading);
  // cmdk: heading lives inside [cmdk-group]
  const groupEl = headingEl.closest('[cmdk-group]');
  if (!groupEl) throw new Error(`no cmdk group for ${String(heading)}`);
  return within(groupEl as HTMLElement);
};

describe('DrivePickerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDriveStore.setState({ drives, currentDriveId: 'drive_coffee', isLoading: false, lastFetched: 0 });
    useFavorites.setState({
      driveIds: new Set(['drive_coffee']),
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
      expect(within(row).getByLabelText('Current drive')).toBeInTheDocument();
      expect(row.getAttribute('data-current')).toBe('true');
      expect(screen.queryByText('current')).not.toBeInTheDocument();
    });

    it('given the actions bar, should offer All drives and Create drive above the list, outside it', () => {
      renderPicker();

      const allDrives = screen.getByRole('button', { name: 'All drives' });
      const create = screen.getByRole('button', { name: 'Create drive' });
      expect(allDrives.closest('[cmdk-list]')).toBeNull();
      expect(create.closest('[cmdk-list]')).toBeNull();
    });
  });

  describe('searching', () => {
    it('given a query, should filter every group and drop Recent, whose order means nothing under a query', async () => {
      renderPicker();

      await userEvent.type(screen.getByPlaceholderText('Search drives…'), 'eng');

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

      expect(push).toHaveBeenCalledWith('/dashboard/drive_eng');
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/drives/drive_eng/access', { method: 'POST' });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(useDriveStore.getState().currentDriveId).toBe('drive_eng');
    });

    it('given a star is tapped, should toggle the favorite and NOT switch drive', async () => {
      const { onOpenChange } = renderPicker();
      const addFavorite = useFavorites.getState().addFavorite;

      // Engineering is listed under Recent AND All drives; either star is the same control.
      await userEvent.click(group('Recent').getByRole('button', { name: 'Add Engineering to favorites' }));

      expect(addFavorite).toHaveBeenCalledWith('drive_eng', 'drive');
      expect(push).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('given All drives, should go to the drives page and close', async () => {
      const { onOpenChange } = renderPicker();

      await userEvent.click(screen.getByRole('button', { name: 'All drives' }));

      expect(push).toHaveBeenCalledWith('/dashboard/drives');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('given Create drive, should hand off to the create dialog', async () => {
      const { onOpenChange } = renderPicker();

      await userEvent.click(screen.getByRole('button', { name: 'Create drive' }));

      expect(screen.getByTestId('create-drive-dialog')).toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
