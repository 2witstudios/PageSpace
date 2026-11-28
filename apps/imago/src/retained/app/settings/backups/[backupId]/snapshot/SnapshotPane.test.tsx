// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { SnapshotPane, type SnapshotMeta } from './SnapshotPane';
import { flattenTree } from './utils';

afterEach(unmountAll);

const pages = flattenTree([
  { pageId: 'p1', title: 'Research Plan', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, stateHash: null, children: [
    { pageId: 'p2', title: 'Questions', type: 'DOCUMENT', parentId: 'p1', position: 0, isTrashed: false, stateHash: null, children: [] },
  ] },
  { pageId: 'p3', title: 'Old draft', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: true, stateHash: null, children: [] },
]);

const backup: SnapshotMeta = { label: 'Weekly · Oct 5', source: 'scheduled', status: 'ready', createdAt: '2026-10-05T03:00:00.000Z' };

describe('SnapshotPane', () => {
  test('renders the All backups link, the header pills and the Pages in snapshot tree with a Trashed badge', () => {
    const container = mount(
      <SnapshotPane backup={backup} nodes={pages} selectedPageId={null} onSelect={() => undefined} onClose={() => undefined} />,
    );
    assert({
      given: 'a ready scheduled snapshot with a nested page and a trashed page',
      should: 'show the All backups link, the Snapshot head, the ready and Scheduled pills and the tree rows with a Trashed badge',
      actual: {
        aside: container.querySelector('aside')?.getAttribute('aria-label'),
        back: container.querySelector('aside a')?.textContent,
        pills: [...container.querySelectorAll('span')].map((node) => node.textContent).filter((text) => text === 'ready' || text === 'Scheduled'),
        tree: container.querySelector('[role="tree"][aria-label="Pages in snapshot"]') !== null,
        rows: [...container.querySelectorAll('[role="treeitem"]')].map((node) => node.textContent),
      },
      expected: {
        aside: 'Snapshot pages',
        back: 'All backups',
        pills: ['ready', 'Scheduled'],
        tree: true,
        rows: ['Research Plan', 'Questions', 'Old draftTrashed'],
      },
    });
  });

  test('a click on a row selects that node', () => {
    const onSelect = vi.fn();
    const container = mount(
      <SnapshotPane backup={backup} nodes={pages} selectedPageId="p2" onSelect={onSelect} onClose={() => undefined} />,
    );
    const rows = container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
    click(rows[0]!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'p1' }));
    assert({
      given: 'the page Questions selected in the tree',
      should: 'mark that row aria-selected',
      actual: [...rows].map((node) => node.getAttribute('aria-selected')),
      expected: ['false', 'true', 'false'],
    });
  });
});
