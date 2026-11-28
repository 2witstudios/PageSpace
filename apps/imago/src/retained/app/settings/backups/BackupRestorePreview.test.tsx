// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import type { RestoreDiff } from '@/retained-adapters/ui-contracts';
import { PreviewCounts } from './BackupRestorePreview';

afterEach(unmountAll);

const diff: RestoreDiff = {
  toCreate: [{ pageId: 'a', title: 'A', type: 'DOCUMENT' }],
  toOverwrite: [{ pageId: 'b', title: 'B', type: 'DOCUMENT', currentHash: null, backupHash: null }, { pageId: 'c', title: 'C', type: 'DOCUMENT', currentHash: null, backupHash: null }],
  toOrphan: [{ pageId: 'd', title: 'D' }],
  unchanged: [{ pageId: 'e' }, { pageId: 'f' }, { pageId: 'g' }],
};

describe('BackupRestorePreview counts', () => {
  test('shows restored, soft-deleted and unchanged page counts from the diff', () => {
    const container = mount(<PreviewCounts diff={diff} />);
    assert({
      given: 'a diff with 3 pages to restore, 1 to soft-delete and 3 unchanged',
      should: 'list the three counts in the board wording',
      actual: [...container.querySelectorAll('li')].map((node) => node.textContent),
      expected: [
        '3 pages will be restored from the snapshot',
        '1 pages added since the backup will be soft-deleted',
        '3 pages unchanged',
      ],
    });
  });
});
