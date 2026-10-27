import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { FileNode } from '../file-model/file-node';
import { browseHref, fileHref, resolveFolder, shortDate, typeLabelOf, viewOf } from './files-browser-model';

const folder = (id: string, children: readonly FileNode[] = []): FileNode => ({
  id,
  name: id,
  kind: 'folder',
  pageType: 'FOLDER',
  count: children.length,
  children,
});
const doc = (id: string): FileNode => ({ id, name: id, kind: 'page', pageType: 'DOCUMENT' });

const tree = [folder('work', [folder('launch', [doc('brief')])]), folder('archive')];

describe('viewOf()', () => {
  test('the remembered view', () => {
    assert({
      given: 'what localStorage holds under imago:files-view',
      should: 'read "grid" as grid and anything else, or nothing, as the list',
      actual: [viewOf('grid'), viewOf('list'), viewOf('bogus'), viewOf(null)],
      expected: ['grid', 'list', 'list', 'list'],
    });
  });
});

describe('typeLabelOf()', () => {
  test('the page type in title case, as the board draws the Type column', () => {
    assert({
      given: 'page types with underscores and one word',
      should: 'title-case each word of the enum name',
      actual: [typeLabelOf('AI_CHAT'), typeLabelOf('TASK_LIST'), typeLabelOf('DOCUMENT')],
      expected: ['Ai Chat', 'Task List', 'Document'],
    });
  });
});

describe('shortDate()', () => {
  test('a date as M/D/YYYY', () => {
    assert({
      given: 'an ISO time on 12 October 2026',
      should: 'read it as 10/12/2026 with no leading zeros',
      actual: shortDate('2026-10-12T10:00:00.000Z'),
      expected: '10/12/2026',
    });
  });
});

describe('links', () => {
  test('a page and a folder address', () => {
    assert({
      given: 'a drive id, a page id and a folder path',
      should: 'address the page under files, and the folder under files/browse by its ids from the top',
      actual: [
        fileHref('d1', 'brief'),
        browseHref('d1', []),
        browseHref('d1', [folder('work'), folder('launch')]),
        browseHref('d 1', [folder('a/b')]),
      ],
      expected: ['/d1/files/brief', '/d1/files/browse', '/d1/files/browse/work/launch', '/d%201/files/browse/a%2Fb'],
    });
  });
});

describe('resolveFolder()', () => {
  test('the drive top, a folder down the tree, and nothing else', () => {
    assert({
      given: 'a tree with a folder two levels down',
      should: 'resolve the top to no path, a folder chain to its path, and refuse a page, a broken chain or an unknown id',
      actual: [
        resolveFolder(tree, [])?.length,
        resolveFolder(tree, ['work', 'launch'])?.map((node) => node.id),
        resolveFolder(tree, ['launch']),
        resolveFolder(tree, ['archive', 'work']),
        resolveFolder(tree, ['work', 'launch', 'brief']),
        resolveFolder(tree, ['missing']),
      ],
      expected: [0, ['work', 'launch'], undefined, undefined, undefined, undefined],
    });
  });
});
