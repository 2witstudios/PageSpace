// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import type { Drive } from '@pagespace/lib/types';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { AccountDrives } from './account-drives';

const mocks = vi.hoisted(() => ({
  drives: [] as Drive[],
  del: vi.fn(),
  patch: vi.fn(),
  removeDrive: vi.fn(),
  updateDrive: vi.fn(),
  fetchDrives: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/retained-adapters/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/retained/components/layout/left-sidebar/CreateDriveDialog', () => ({ default: () => null }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ del: mocks.del, patch: mocks.patch }));
vi.mock('@/retained/hooks/useFavorites', () => ({
  useFavorites: () => ({
    isFavorite: () => false,
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
    driveIds: new Set<string>(),
  }),
  useFavoritesSync: () => undefined,
}));
vi.mock('@/retained/hooks/useDrive', () => {
  const state = {
    get drives() {
      return mocks.drives;
    },
    fetchDrives: mocks.fetchDrives,
    updateDrive: mocks.updateDrive,
    removeDrive: mocks.removeDrive,
  };
  return {
    useDriveStore: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

const studio: Drive = {
  id: 'a',
  name: 'Studio',
  slug: 'a',
  ownerId: 'me',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
};

const findButton = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === label || item.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`${label} is missing`);
  return found;
};

const menuItem = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`${label} menu item is missing`);
  return found as HTMLButtonElement;
};

const dialogTitles = (): string[] =>
  [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map(
    (dialog) => dialog.querySelector('h2')?.textContent ?? '',
  );

beforeEach(() => {
  mocks.drives = [studio];
  mocks.patch.mockReset().mockResolvedValue({});
  mocks.del.mockReset().mockResolvedValue({});
  mocks.removeDrive.mockReset();
  mocks.updateDrive.mockReset();
  mocks.fetchDrives.mockReset();
  mocks.push.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.toast.loading.mockReset().mockReturnValue('toast-id');
});

afterEach(unmountAll);

describe('AccountDrives row actions', () => {
  test('Drive actions opens the drive’s menu, and Move to trash opens the Delete Drive? confirmation', () => {
    mount(<AccountDrives />);
    click(findButton('Drive actions'));
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Studio actions');
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
      'Open',
      'Rename',
      'Favorite',
      'Move to trash',
    ]);

    click(menuItem('Move to trash'));
    expect(dialogTitles()).toContain('Delete Drive?');
  });

  test('Rename opens the Rename Drive dialog', () => {
    mount(<AccountDrives />);
    click(findButton('Drive actions'));
    click(menuItem('Rename'));
    expect(dialogTitles()).toContain('Rename Drive');
  });

  test('Open leaves the page for the drive’s Files', () => {
    mount(<AccountDrives />);
    click(findButton('Drive actions'));
    click(menuItem('Open'));
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  test('confirming the trash name deletes the drive and removes it from the store', async () => {
    mount(<AccountDrives />);
    click(findButton('Drive actions'));
    click(menuItem('Move to trash'));

    const input = document.querySelector('#drive-name-confirmation') as HTMLInputElement;
    typeInto(input, 'Studio');
    await act(async () => {
      click(findButton('Delete Drive'));
    });

    await vi.waitFor(() => expect(mocks.removeDrive).toHaveBeenCalledWith('a'));
    expect(mocks.del).toHaveBeenCalledWith('/api/drives/a');
    expect(mocks.toast.success).toHaveBeenCalledWith('Drive moved to trash.', { id: 'toast-id' });
  });
});
