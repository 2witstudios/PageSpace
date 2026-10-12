// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { createInitialState } from '@/ui/store/state';
import { setUiState, getUiState } from '@/ui/store/store';
import { useUIStore } from '@/retained/stores/useUIStore';
const drive = vi.hoisted(() => ({ permission: undefined as boolean | undefined, fetch: async () => {} }));
vi.mock('@/retained/hooks/useDrive', () => ({ useDriveStore: <T,>(selector: (state: { drives: { id: string; canCreatePages?: boolean }[]; fetchDrives: () => Promise<void> }) => T) => selector({ drives: [{ id: 'd1', canCreatePages: drive.permission }], fetchDrives: drive.fetch }) }));
vi.mock('@/retained/components/layout/left-sidebar/page-tree/PageTree', () => ({ default: ({ driveId, searchQuery }: { driveId: string; searchQuery: string }) => <div data-retained-tree={driveId} data-filter={searchQuery} /> }));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: import('react').ReactNode }) => children }));
const { FilesPane } = await import('./files-pane');
beforeEach(() => { drive.permission = undefined; setUiState(createInitialState()); useUIStore.getState().closeQuickCreate(); });
afterEach(unmountAll);
const show = () => mount(<FilesPane driveId="d1" selectedPageId="p1" variant="tree" title="Files" />);
it('mounts the retained tree in the existing list pane', () => {
  const container = show(); expect(container.querySelector('[data-retained-tree]')?.getAttribute('data-retained-tree')).toBe('d1');
});
it.each([undefined, false])('creation fails closed for permission %s', permission => {
  drive.permission = permission; const container = show(); expect((container.querySelector('[aria-label="New page"]') as HTMLButtonElement).disabled).toBe(true);
});
it('creation opens the retained type palette when the server permits it', () => {
  drive.permission = true; const container = show(); click(container.querySelector('[aria-label="New page"]')!); expect(useUIStore.getState().quickCreateOpen).toBe(true);
});
it('typing filters the retained tree', () => {
  const container = show(); typeInto(container.querySelector('input')!, 'Notes'); expect(container.querySelector('[data-retained-tree]')?.getAttribute('data-filter')).toBe('Notes');
});
it('Close sidebar collapses the files section through the per-section shell state', () => {
  const container = show(); click(container.querySelector('[aria-label="Close sidebar"]')!); expect(getUiState().resources.collapsedSections).toContain('files');
});

it('lists this drive’s favorites and recents above the pages (IMC-1.8)', async () => {
  const { createApiClient } = await import('@/api/client');
  const { ImagoSWRProvider } = await import('@/api/swr-provider');
  const { act } = await import('react');
  const now = Date.now();
  const bodies: Record<string, unknown> = {
    '/api/user/favorites': { favorites: [
      { id: 'f1', itemType: 'page', page: { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT', driveId: 'd1' } },
      { id: 'f2', itemType: 'page', page: { id: 'other', title: 'Elsewhere', type: 'DOCUMENT', driveId: 'd2' } },
    ] },
    '/api/user/recents': { recents: [
      { id: 'ops', title: 'launch-ops', type: 'CHANNEL', driveId: 'd1', viewedAt: new Date(now - 2 * 3600_000).toISOString() },
    ] },
  };
  const client = createApiClient({
    fetch: async (input) => Response.json(bodies[new URL(input, 'http://x').pathname] ?? {}),
    navigate: () => {},
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/d1/files' }),
  });
  const container = mount(<ImagoSWRProvider client={client}><FilesPane driveId="d1" selectedPageId="plan" variant="tree" title="Files" /></ImagoSWRProvider>);
  await act(() => vi.waitFor(() => { if (!container.textContent?.includes('#launch-ops')) throw new Error('not loaded'); }, { timeout: 1000 }));
  const groups = [...container.querySelectorAll('button[aria-expanded]')].map((button) => button.textContent);
  const rows = [...container.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('aria-current')]);
  expect(groups).toEqual(['Favorites', 'Recents', 'Pages']);
  expect(rows).toEqual([['Q4 Launch Plan', 'page'], ['#launch-ops2h', null]]);
  expect(container.querySelector('input')?.getAttribute('placeholder')).toBe('Filter pages');
});
