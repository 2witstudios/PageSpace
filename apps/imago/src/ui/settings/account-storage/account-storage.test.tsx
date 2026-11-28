// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { AccountStorageView } from './account-storage';
import { storageOf } from './account-storage-model';

afterEach(unmountAll);

const storage = storageOf({
  quota: { usedBytes: 311 * 1024 * 1024, formattedUsed: '311 MB', formattedQuota: '2 GB', formattedAvailable: '1.7 GB' },
  tierInfo: { name: 'Pro', maxFileSize: 250 * 1024 * 1024, maxConcurrentUploads: 5, maxFileCount: 500 },
  totalFiles: 128,
  fileTypeBreakdown: { PDFs: { count: 21, totalSize: 142 * 1024 * 1024 }, Images: { count: 88, totalSize: 96 * 1024 * 1024 } },
  storageByDrive: [{ driveId: 'd1', driveName: 'Studio', fileCount: 128, formattedSize: '311 MB' }],
  largestFiles: [{ id: 'p1', title: 'Talk.mp4', mimeType: 'video/mp4', formattedSize: '38 MB' }],
  recentFiles: [],
});

const view = (overrides: Partial<Parameters<typeof AccountStorageView>[0]> = {}) =>
  mount(<AccountStorageView storage={storage} isAdmin={false} reconciling={false} onRecalculate={() => {}} {...overrides} />);

describe('AccountStorageView', () => {
  test('renders one h1, the quota heading, the type bar and the drive, file lists', () => {
    const container = view();
    assert({
      given: 'a loaded summary',
      should: 'show the tier and quota as the section heading and the storage-by-type bar',
      actual: {
        h1: container.querySelector('h1')?.textContent,
        quota: container.querySelector('section h2')?.textContent,
        bar: container.querySelector('[role="img"]')?.getAttribute('aria-label'),
        headings: [...container.querySelectorAll('h2')].map((heading) => heading.textContent),
      },
      expected: {
        h1: 'Storage',
        quota: 'Pro · 2 GB quota',
        bar: 'Storage by type: PDFs 46%, Images 31% of used space',
        headings: ['Pro · 2 GB quota', 'By drive', 'Largest files', 'Recent uploads'],
      },
    });
  });

  test('a non-admin does not see Recalculate', () => {
    const container = view({ isAdmin: false });
    assert({
      given: 'a viewer who is not an admin',
      should: 'not offer Recalculate',
      actual: [...container.querySelectorAll('button')].map((button) => button.textContent),
      expected: [],
    });
  });

  test('an admin sees Recalculate, which calls onRecalculate', () => {
    const onRecalculate = vi.fn();
    const container = view({ isAdmin: true, onRecalculate });
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Recalculate');
    if (button === undefined) throw new Error('Recalculate is missing');
    click(button);
    assert({
      given: 'an admin pressing Recalculate',
      should: 'request a reconcile through the handler',
      actual: onRecalculate.mock.calls.length,
      expected: 1,
    });
  });

  test('no files shows an empty line in each file list, not an invented row', () => {
    const empty = storageOf({ quota: { usedBytes: 0, formattedUsed: '0 B', formattedQuota: '2 GB', formattedAvailable: '2 GB' }, totalFiles: 0, tierInfo: { name: 'Free' }, fileTypeBreakdown: {}, storageByDrive: [], largestFiles: [], recentFiles: [] });
    const container = mount(<AccountStorageView storage={empty} isAdmin={false} reconciling={false} onRecalculate={() => {}} />);
    assert({
      given: 'an account with no files',
      should: 'say No files yet under each file list and omit the bar',
      actual: {
        empties: [...container.querySelectorAll('p')].map((p) => p.textContent).filter((text) => text === 'No files yet').length,
        bar: container.querySelector('[role="img"]'),
      },
      expected: { empties: 2, bar: null },
    });
  });

  test('before the summary loads, only the title and lede show', () => {
    const container = mount(<AccountStorageView storage={null} isAdmin={false} reconciling={false} onRecalculate={() => {}} />);
    assert({
      given: 'no summary yet',
      should: 'render the h1 and no sections',
      actual: { h1: container.querySelector('h1')?.textContent, sections: container.querySelectorAll('section').length },
      expected: { h1: 'Storage', sections: 0 },
    });
  });
});
