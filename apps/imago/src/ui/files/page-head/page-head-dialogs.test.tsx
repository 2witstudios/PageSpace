// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PageActionDialog } from '../page-actions/page-actions-model';

const state = vi.hoisted(() => ({
  tree: [{ id: 'plan', children: [{ id: 'kid' }] }] as unknown,
  patch: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
  toast: { loading: vi.fn(() => 'id'), success: vi.fn(), error: vi.fn() },
  mutate: vi.fn(async () => undefined),
  openQuickCreate: vi.fn(),
}));

vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: unknown }) => children }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('swr', () => ({ default: () => ({ data: state.tree }), useSWRConfig: () => ({ mutate: state.mutate }) }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ patch: state.patch, del: state.del }));
vi.mock('@/retained/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ openQuickCreate: state.openQuickCreate }) } }));
vi.mock('../page-object/page-object', () => ({
  usePage: () => ({ data: { title: 'Q4 Launch Plan', type: 'DOCUMENT', isPrivate: false, parentId: null } }),
  pageKey: (id: string) => `/api/pages/${id}`,
}));
vi.mock('@/retained/components/dialogs/MovePageDialog', () => ({ MovePageDialog: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <p>Move dialog</p> : null) }));
vi.mock('@/retained/components/dialogs/CopyPageDialog', () => ({ CopyPageDialog: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <p>Copy dialog</p> : null) }));
vi.mock('@/retained/components/layout/middle-content/content-header/page-settings/ShareDialog', () => ({
  ShareDialog: ({ open }: { open?: boolean }) => (open ? <p>Permissions dialog</p> : null),
}));

import { PageHeadDialogs, openAddChild } from './page-head-dialogs';

const show = (dialog: PageActionDialog | null, onClose = vi.fn()) => {
  render(<PageHeadDialogs pageId="plan" driveId="d1" dialog={dialog} onClose={onClose} />);
  return onClose;
};

afterEach(() => {
  cleanup();
  state.tree = [{ id: 'plan', children: [{ id: 'kid' }] }];
  vi.clearAllMocks();
});

describe('PageHeadDialogs (IMC-9.4, 9.5)', () => {
  it('saving Rename patches the title and toasts', async () => {
    const onClose = show('rename');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Q1 Plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('Page renamed.', { id: 'id' }));
    expect(state.patch).toHaveBeenCalledWith('/api/pages/plan', { title: 'Q1 Plan' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Trash with pages inside offers both variants; "page only" keeps the contents', async () => {
    show('trash');
    fireEvent.click(screen.getByRole('button', { name: 'Move Page Only' }));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('Page moved to trash.', { id: 'id' }));
    expect(state.del).toHaveBeenCalledWith('/api/pages/plan', { trash_children: false });
    expect(screen.queryByRole('button', { name: 'Move Page and All Contents' })).not.toBeNull();
  });

  it('Trash without pages inside is one Move to Trash', async () => {
    state.tree = [{ id: 'plan' }];
    show('trash');
    expect(screen.queryByRole('button', { name: 'Move Page Only' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(state.del).toHaveBeenCalledWith('/api/pages/plan', { trash_children: true }));
  });

  it('opens Move to…, Copy to… and Permissions for the page', () => {
    for (const [dialog, text] of [['move', 'Move dialog'], ['copy', 'Copy dialog'], ['permissions', 'Permissions dialog']] as const) {
      show(dialog);
      expect(screen.queryByText(text)).not.toBeNull();
      cleanup();
    }
  });

  it('Add child page opens the create palette under the page', () => {
    openAddChild('plan');
    expect(state.openQuickCreate).toHaveBeenCalledWith('plan', null);
  });
});
