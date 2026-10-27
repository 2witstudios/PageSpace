// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { SnapshotReader, type SnapshotReaderProps } from './SnapshotReader';

afterEach(unmountAll);

const base: SnapshotReaderProps = {
  page: { pageId: 'p1', title: 'Research Plan' },
  snapshotAt: '2026-10-05T03:00:00.000Z',
  content: 'What we want to learn.',
  loading: false,
  restorable: true,
  onRestore: () => undefined,
  onClose: () => undefined,
  showPaneToggle: false,
  onShowPane: () => undefined,
};

describe('SnapshotReader', () => {
  test('a selected page shows the read-only note with Open current version and its content', () => {
    const container = mount(<SnapshotReader {...base} />);
    const note = container.querySelector('[role="note"]');
    assert({
      given: 'a selected page from the snapshot',
      should: 'show the read-only note naming the page with Open current version, and the content with no edit count',
      actual: {
        note: note?.textContent?.startsWith('Read-only — this is how Research Plan looked on '),
        link: note?.querySelector('a')?.getAttribute('href'),
        linkText: note?.querySelector('a')?.textContent,
        edits: container.textContent?.includes('edited'),
        content: container.querySelector('pre')?.textContent,
      },
      expected: {
        note: true,
        link: '/p/p1',
        linkText: 'Open current version',
        edits: false,
        content: 'What we want to learn.',
      },
    });
  });

  test('no page selected shows Nothing open and no note', () => {
    const container = mount(<SnapshotReader {...base} page={null} />);
    assert({
      given: 'no page picked from the tree',
      should: 'show Nothing open in the middle and no read-only note',
      actual: { nothing: container.textContent?.includes('Nothing open'), note: container.querySelector('[role="note"]') },
      expected: { nothing: true, note: null },
    });
  });

  test('a trashed page with its content still loading shows the loading line', () => {
    const container = mount(<SnapshotReader {...base} page={{ pageId: 'p3', title: 'Old draft' }} content={undefined} loading />);
    assert({
      given: 'a trashed page whose content is loading',
      should: 'show Loading content and the page title as the heading',
      actual: { loading: container.textContent?.includes('Loading content…'), heading: container.querySelector('h1')?.textContent },
      expected: { loading: true, heading: 'Old draft' },
    });
  });

  test('Restore from this snapshot is disabled unless the backup is ready, and fires otherwise', () => {
    const onRestore = vi.fn();
    const container = mount(<SnapshotReader {...base} restorable onRestore={onRestore} />);
    const restore = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Restore from this snapshot'))!;
    click(restore);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
