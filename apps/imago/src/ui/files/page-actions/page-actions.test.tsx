// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useDriveStore } from '@/retained/hooks/useDrive';

const state = vi.hoisted(() => ({
  client: { apiFetch: vi.fn(), apiStream: vi.fn() },
  page: { title: 'Q4 Launch Plan', type: 'DOCUMENT', isPrivate: false, parentId: 'launch', driveId: 'd1' } as Record<string, unknown> | undefined,
  favorites: undefined as unknown,
  toast: { loading: vi.fn(() => 'id'), success: vi.fn(), error: vi.fn() },
  absorb: false,
}));

vi.mock('@/api/swr-provider', () => ({ useApiClient: () => state.client }));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: unknown }) => children }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('swr', () => ({
  default: (key: string) => ({ data: key === '/api/user/favorites' ? state.favorites : undefined }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('./page-actions-flag', () => ({
  get PAGE_ACTIONS_ABSORB_HEADER() {
    return state.absorb;
  },
}));
vi.mock('../page-object/page-object', () => ({ usePage: () => ({ data: state.page }), pageKey: (id: string) => `/api/pages/${id}` }));

import { PageActionsMenu } from './page-actions';

const openMenu = (onDialog = vi.fn()) => {
  render(
    <PageActionsMenu
      driveId="d1"
      pageId="plan"
      onDialog={onDialog}
      trigger={<button type="button" aria-label="Page actions">…</button>}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'Page actions' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return { onDialog };
};

afterEach(() => {
  cleanup();
  state.page = { title: 'Q4 Launch Plan', type: 'DOCUMENT', isPrivate: false, parentId: 'launch', driveId: 'd1' };
  state.favorites = undefined;
  state.absorb = false;
  useDriveStore.setState({ drives: [] });
  vi.clearAllMocks();
});

describe('PageActionsMenu (IMC-9.3)', () => {
  it('is closed until its trigger opens it', () => {
    render(<PageActionsMenu driveId="d1" pageId="plan" trigger={<button type="button">…</button>} onDialog={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a menu named for the page with the tree actions', () => {
    openMenu();
    const menu = screen.getByRole('menu', { name: 'Page actions for Q4 Launch Plan' });
    const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual([
      'Open in new tab',
      'Add child page',
      'Rename',
      'Favorite',
      'Protect page',
      'Permissions',
      'Select multiple',
      'Move to...',
      'Copy to...',
      'Trash',
    ]);
  });

  it('shows Unfavorite and Unprotect page for a favorited, protected page', () => {
    state.page = { ...state.page, isPrivate: true };
    state.favorites = { favorites: [{ id: 'row', itemType: 'page', page: { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT', driveId: 'd1' } }] };
    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Unfavorite')).toBeTruthy();
    expect(within(menu).getByText('Unprotect page')).toBeTruthy();
  });

  it('offers Set as home page only to a viewer who can manage the drive', () => {
    useDriveStore.setState({ drives: [{ id: 'd1', isOwned: true, homePageId: null } as never] });
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Set as home page' })).toBeTruthy();
  });

  it('hides home page from a member', () => {
    useDriveStore.setState({ drives: [{ id: 'd1', isOwned: false, role: 'MEMBER' } as never] });
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Set as home page' })).toBeNull();
  });

  it('hands a dialog item to the page container', () => {
    const { onDialog } = openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onDialog).toHaveBeenCalledWith('rename');
  });

  it('offers no dialog items without a dialog host', () => {
    render(<PageActionsMenu driveId="d1" pageId="plan" trigger={<button type="button" aria-label="Page actions">…</button>} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Page actions' }), { key: 'Enter' });
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Select multiple' })).toBeTruthy();
  });
});

describe('PageActionsMenu with the header flag on (IMC-9.3)', () => {
  it('opens an Export submenu of the document formats, and Print after it', () => {
    state.absorb = true;
    openMenu();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Export' }), { key: 'Enter' });
    const submenu = screen.getByRole('menu', { name: 'Export' });
    expect(within(submenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Export as DOCX',
      'Export as Markdown',
    ]);
    expect(screen.getByRole('menuitem', { name: 'Print' })).toBeTruthy();
  });

  it('downloads the export the chosen format names', async () => {
    state.absorb = true;
    state.client.apiStream.mockResolvedValue({ blob: async () => new Blob(['x']) });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    openMenu();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Export' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as Markdown' }));
    await vi.waitFor(() => expect(state.client.apiStream).toHaveBeenCalledWith('/api/pages/plan/export/markdown'));
    await vi.waitFor(() => expect(state.toast.success).toHaveBeenCalledWith('Exported as Markdown', { id: 'id' }));
  });
});
