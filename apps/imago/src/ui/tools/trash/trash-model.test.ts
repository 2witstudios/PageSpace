import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  deleteDetail,
  formatBytes,
  metaLabel,
  rowsMatching,
  trashFilterFrom,
  trashRows,
  trashedLabel,
  wasInLabel,
  withoutPage,
  type TrashPage,
} from './trash-model';

const page = (overrides: Partial<TrashPage> & Pick<TrashPage, 'id' | 'title'>): TrashPage => ({
  type: 'DOCUMENT',
  parentId: null,
  originalParentId: null,
  position: 0,
  trashedAt: '2026-10-11T12:00:00.000Z',
  children: [],
  ...overrides,
});

const folder: TrashPage = page({
  id: 'f1',
  title: 'Old pricing draft',
  type: 'FOLDER',
  originalParentId: 'launch',
  children: [
    page({ id: 'c1', title: 'Tier sketch', type: 'SHEET', parentId: 'f1' }),
    page({ id: 'c2', title: 'Notes from call', parentId: 'f1', children: [page({ id: 'g1', title: 'Call audio', parentId: 'c2' })] }),
  ],
});
const banner = page({ id: 'b1', title: 'launch-banner@2x.png', type: 'FILE', fileSize: 1887436, originalParentId: 'launch' });
const tree: TrashPage[] = [folder, banner];

describe('trashRows', () => {
  test('flattens the tree depth first, marking top-level rows and the folder each child sits under', () => {
    const rows = trashRows(tree);
    assert({
      given: 'a folder with nested pages and a loose file',
      should: 'list every page depth first, with its depth, top flag and the folder it sits under',
      actual: rows.map((row) => [row.id, row.depth, row.top, row.parentTitle]),
      expected: [
        ['f1', 0, true, null],
        ['c1', 1, false, 'Old pricing draft'],
        ['c2', 1, false, 'Old pricing draft'],
        ['g1', 2, false, 'Notes from call'],
        ['b1', 0, true, null],
      ],
    });
  });

  test('counts the pages inside each row at any depth', () => {
    assert({
      given: 'a folder holding two pages, one of which holds a third',
      should: 'count three descendants on the folder and none on a leaf',
      actual: trashRows(tree).map((row) => row.descendants),
      expected: [3, 0, 1, 0, 0],
    });
  });
});

describe('rowsMatching', () => {
  test('keeps FILE pages for Files and everything else for Pages', () => {
    const rows = trashRows(tree);
    assert({
      given: 'the Pages and Files filters',
      should: 'split rows by whether they are files',
      actual: [
        rowsMatching(rows, 'all').length,
        rowsMatching(rows, 'pages').map((row) => row.id),
        rowsMatching(rows, 'files').map((row) => row.id),
      ],
      expected: [5, ['f1', 'c1', 'c2', 'g1'], ['b1']],
    });
  });

  test('reads an unknown or missing ?type= as All', () => {
    assert({
      given: 'no type query, an unknown one, and each known one',
      should: 'fall back to all',
      actual: [null, 'docs', 'pages', 'files'].map(trashFilterFrom),
      expected: ['all', 'all', 'pages', 'files'],
    });
  });
});

describe('wasInLabel', () => {
  test('names a child by its folder and a top-level page by its original parent', () => {
    const rows = trashRows(tree);
    const titles = new Map([['launch', 'Launch']]);
    assert({
      given: 'a child, and a top-level page whose original parent is known and unknown',
      should: 'show the folder for a child, the parent title when known, and null otherwise',
      actual: [wasInLabel(rows[1]!, titles), wasInLabel(rows[0]!, titles), wasInLabel(rows[4]!, new Map())],
      expected: ['Old pricing draft', 'Launch', null],
    });
  });
});

describe('withoutPage', () => {
  test('takes a page and everything inside it out of the tree', () => {
    assert({
      given: 'a restore or a delete of the folder',
      should: 'remove the folder with its children and keep the loose file',
      actual: withoutPage(tree, 'f1').map((node) => node.id),
      expected: ['b1'],
    });
  });
});

describe('metaLabel and formatBytes', () => {
  test('shows a file size and a folder page count, and nothing for a plain page', () => {
    const rows = trashRows(tree);
    assert({
      given: 'a folder with two pages, a 1.8 MB file, and a page with nothing inside',
      should: 'label the folder with its page count and the file with its size',
      actual: [metaLabel(rows[0]!), metaLabel(rows[4]!), metaLabel(rows[1]!), formatBytes(512), formatBytes(2048)],
      expected: ['3 pages', '1.8 MB', null, '512 B', '2.0 KB'],
    });
  });
});

describe('trashedLabel', () => {
  test('reads a trashed time against today as Today, Yesterday, or a short date', () => {
    const now = new Date(2026, 9, 12, 15, 0, 0);
    assert({
      given: 'a time today, yesterday, and earlier, and no time',
      should: 'name the day, or give a short date',
      actual: [
        trashedLabel(new Date(2026, 9, 12, 8).toISOString(), now),
        trashedLabel(new Date(2026, 9, 11, 23).toISOString(), now),
        trashedLabel(new Date(2026, 9, 6, 9).toISOString(), now),
        trashedLabel(null, now),
      ],
      expected: ['Today', 'Yesterday', 'Oct 6', '—'],
    });
  });
});

describe('deleteDetail', () => {
  test('says what a permanent delete takes with it', () => {
    const rows = trashRows(tree);
    assert({
      given: 'a folder with two pages inside, and a page with none',
      should: 'name the pages inside, or leave them out',
      actual: [deleteDetail(rows[0]!), deleteDetail(rows[4]!)],
      expected: [
        'Its content, version history and the 3 pages inside it can’t be restored after this.',
        'Its content and version history can’t be restored after this.',
      ],
    });
  });
});
