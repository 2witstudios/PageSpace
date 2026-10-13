import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { bytesLabel, storageOf, typesOf } from './account-storage-model';

const body = {
  quota: {
    usedBytes: 311 * 1024 * 1024,
    formattedUsed: '311 MB',
    formattedQuota: '2 GB',
    formattedAvailable: '1.7 GB',
  },
  tierInfo: { name: 'Pro', maxFileSize: 250 * 1024 * 1024, maxConcurrentUploads: 5, maxFileCount: 500 },
  totalFiles: 128,
  fileTypeBreakdown: {
    PDFs: { count: 21, totalSize: 142 * 1024 * 1024 },
    Images: { count: 88, totalSize: 96 * 1024 * 1024 },
    Videos: { count: 2, totalSize: 41 * 1024 * 1024 },
    Archives: { count: 17, totalSize: 32 * 1024 * 1024 },
  },
  storageByDrive: [{ driveId: 'd1', driveName: 'Studio', fileCount: 128, formattedSize: '311 MB' }],
  largestFiles: [{ id: 'p1', title: 'Talk.mp4', mimeType: 'video/mp4', formattedSize: '38 MB' }],
  recentFiles: [{ id: 'p2', title: 'Logo.png', mimeType: 'image/png', createdAt: new Date().toISOString(), formattedSize: '1 MB' }],
};

describe('storageOf', () => {
  test('reads the quota, limits, drives and files the summary sends', () => {
    const view = storageOf(body);
    assert({
      given: 'a storage summary',
      should: 'carry the tier, quota, used and available as the API formats them',
      actual: [view?.tier, view?.quota, view?.used, view?.available],
      expected: ['Pro', '2 GB', '311 MB', '1.7 GB'],
    });
    assert({
      given: 'a storage summary',
      should: 'list the limits the tier allows, in board order',
      actual: view?.limits,
      expected: [
        { label: 'Files', value: '128' },
        { label: 'Max file size', value: '250MB' },
        { label: 'Concurrent uploads', value: '5' },
        { label: 'Max files', value: '500' },
      ],
    });
    assert({
      given: 'a summary with drives and largest and recent files',
      should: 'map them to rows with their sizes and a relative upload time',
      actual: {
        drives: view?.drives,
        largest: view?.largest,
        recentDetail: view?.recent[0]?.detail.startsWith('1 MB · '),
      },
      expected: {
        drives: [{ driveId: 'd1', name: 'Studio', files: 128, size: '311 MB' }],
        largest: [{ id: 'p1', title: 'Talk.mp4', detail: '38 MB' }],
        recentDetail: true,
      },
    });
  });

  test('a body that is not a summary is null, never a made-up figure', () => {
    assert({
      given: 'an error body',
      should: 'return null',
      actual: storageOf({ error: 'Unauthorized' }),
      expected: null,
    });
  });

  test('no files and no drives leave empty lists, and the Files limit reads 0', () => {
    const view = storageOf({ ...body, totalFiles: 0, fileTypeBreakdown: {}, storageByDrive: [], largestFiles: [], recentFiles: [] });
    assert({
      given: 'an account with no files',
      should: 'show empty lists and an empty type bar',
      actual: { types: view?.types, drives: view?.drives, largest: view?.largest, recent: view?.recent, files: view?.limits[0] },
      expected: { types: [], drives: [], largest: [], recent: [], files: { label: 'Files', value: '0' } },
    });
  });
});

describe('typesOf', () => {
  test('folds the API categories into the four board segments, largest share first', () => {
    const types = typesOf(body.fileTypeBreakdown, 311 * 1024 * 1024);
    assert({
      given: 'PDFs, images, videos and archives',
      should: 'fold archives into Other and order the segments by bytes',
      actual: types.map((type) => [type.label, type.count, Math.round(type.percent)]),
      expected: [
        ['PDF', 21, 46],
        ['Images', 88, 31],
        ['Video', 2, 13],
        ['Other', 17, 10],
      ],
    });
  });

  test('a zero-byte used total gives 0% for every segment rather than dividing by zero', () => {
    assert({
      given: 'files but nothing used',
      should: 'report 0 percent',
      actual: typesOf({ PDFs: { count: 1, totalSize: 0 } }, 0).map((type) => type.percent),
      expected: [0],
    });
  });
});

describe('bytesLabel', () => {
  test('writes whole units without a space, as the board does', () => {
    assert({
      given: 'a 250 MB limit and a zero size',
      should: 'read 250MB and 0B',
      actual: [bytesLabel(250 * 1024 * 1024), bytesLabel(0)],
      expected: ['250MB', '0B'],
    });
  });
});
