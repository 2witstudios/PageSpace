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

describe('storageOf on a sparse summary', () => {
  test('falls back to the Free tier and empty figures when the API omits the optional parts', () => {
    const view = storageOf({ quota: {} });
    assert({
      given: 'a body with a quota and nothing else',
      should: 'name the Free tier, leave the figures blank, and list only the Files limit',
      actual: [view?.tier, view?.quota, view?.used, view?.available, view?.usedBytes, view?.limits, view?.types, view?.drives],
      expected: ['Free', '', '', '', 0, [{ label: 'Files', value: '0' }], [], []],
    });
  });

  test('defaults the blanks of every row it is sent', () => {
    const view = storageOf({
      quota: { usedBytes: 10 },
      storageByDrive: [{}, 'junk'],
      largestFiles: [{ id: '', title: '' }],
      recentFiles: [
        { id: 'a', title: 'No date', formattedSize: '2 MB' },
        { id: 'b', title: 'Bad date', formattedSize: '3 MB', createdAt: 'not a date' },
        { id: 'c' },
      ],
    });
    assert({
      given: 'rows missing their ids, titles, sizes and dates',
      should: 'use an empty id, "Untitled file", "Untitled drive" and the size alone when the date is missing or invalid',
      actual: [view?.drives, view?.largest, view?.recent],
      expected: [
        [{ driveId: '', name: 'Untitled drive', files: 0, size: '' }],
        [{ id: '', title: 'Untitled file', detail: '' }],
        [
          { id: 'a', title: 'No date', detail: '2 MB' },
          { id: 'b', title: 'Bad date', detail: '3 MB' },
          { id: 'c', title: 'Untitled file', detail: '' },
        ],
      ],
    });
  });

  test('reads a body that is not a summary as nothing loaded', () => {
    assert({
      given: 'an error body, a missing quota and a non-object',
      should: 'give no view',
      actual: [storageOf({ error: 'x' }), storageOf({ quota: 5 }), storageOf(null)],
      expected: [null, null, null],
    });
  });
});

describe('typesOf edge cases', () => {
  test('folds categories into Other, skips malformed ones and gives no share without used bytes', () => {
    assert({
      given: 'two unknown categories, a junk entry, a zero-count category and no used bytes',
      should: 'merge the unknowns into one Other segment with 0 percent, dropping the rest',
      actual: typesOf(
        { Docs: { count: 1, totalSize: 5 }, Archives: { count: 2 }, Broken: 'x', PDFs: { count: 0, totalSize: 9 }, Odd: { count: 'many' } },
        0,
      ),
      expected: [{ label: 'Other', count: 3, bytes: 5, percent: 0 }],
    });
    assert({
      given: 'a breakdown that is not an object',
      should: 'draw no segments',
      actual: typesOf(null, 10),
      expected: [],
    });
  });
});

describe('bytesLabel edge cases', () => {
  test('writes tiny, NaN and huge sizes without going off the unit scale', () => {
    assert({
      given: 'zero, NaN, one byte, and far more than a terabyte',
      should: '0B for the first two, then B, and capped at TB',
      actual: [bytesLabel(0), bytesLabel(Number.NaN), bytesLabel(1), bytesLabel(5 * 1024 ** 5)],
      expected: ['0B', '0B', '1B', '5120TB'],
    });
  });
});
