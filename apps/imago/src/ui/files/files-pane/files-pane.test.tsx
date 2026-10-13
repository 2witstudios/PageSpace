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
const show = () => mount(<FilesPane driveId="d1" selectedPageId="p1" variant="tree" title="Files" closeHref="/d1" />);
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
it('closing the tree uses the original per-section shell state', () => {
  const container = show(); click(container.querySelector('[aria-label="Hide Files"]')!); expect(getUiState().resources.collapsedSections).toContain('files');
});
