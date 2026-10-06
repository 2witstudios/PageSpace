// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import type { FileNode } from '../file-model/file-node';
import type { FileTree } from '../use-file-tree/use-file-tree';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

/**
 * The tree FolderView reads, as useFileTree hands it over once a children
 * load has merged a page into it that the drive tree answer does not list
 * (apps/web's children route checks only the parent).
 */
const seam = vi.hoisted(() => ({ tree: null as FileTree | null }));
vi.mock('../use-file-tree/use-file-tree', () => ({
  useFileTree: () => seam.tree,
}));

vi.mock('@/api/swr-provider', () => ({ useApiClient: () => ({}) }));

const { FolderView } = await import('./folder-view');

const doc = (id: string, name: string): FileNode => ({
  id,
  name,
  kind: 'page',
  pageType: 'DOCUMENT',
  updatedAt: '2026-10-05T09:12:00.000Z',
});

/** Launch (folder) › Brief (listed), Secret (named only by a children load). */
const launch: FileNode = {
  id: 'launch',
  name: 'Launch',
  kind: 'folder',
  pageType: 'FOLDER',
  count: 2,
  children: [doc('brief', 'Brief'), doc('secret', 'Secret')],
};

const treeOf = (listed: readonly string[]): FileTree => ({
  nodes: [launch],
  error: undefined,
  isLoading: false,
  expandedIds: [],
  loadingIds: [],
  toggle: () => {},
  loadChildren: async () => ({ ok: true }),
  retry: () => {},
  rename: () => {},
  listedIds: new Set(listed),
});

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(unmountAll);

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody tr [data-name]')].map((name) => name.textContent);

describe('FolderView and the drive tree’s listing', () => {
  test('a child the drive tree does not list', () => {
    seam.tree = treeOf(['launch', 'brief']);
    const container = mount(<FolderView driveId="d1" folderId="launch" />);
    assert({
      given: 'a tree holding a child of the open folder that the drive tree answer does not list',
      should: 'draw only the listed child',
      actual: rowNames(container),
      expected: ['Brief'],
    });
  });

  test('a folder the drive tree does not list', () => {
    seam.tree = treeOf(['brief', 'secret']);
    const container = mount(<FolderView driveId="d1" folderId="launch" />);
    assert({
      given: 'an open folder that only a children load named',
      should: 'draw it as any unknown page, with none of its children',
      actual: [rowNames(container), container.querySelector('table')],
      expected: [[], null],
    });
  });
});
