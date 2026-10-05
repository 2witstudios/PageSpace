import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { treeRow } from '../file-model/fixtures';
import { fileNodesFrom } from '../file-model/from-api';
import type { FileNode } from '../file-model/file-node';
import type { PendingFile } from '../files-plugin/files-plugin';
import {
  childIdsOf,
  createParentFor,
  disclosableIds,
  fileIcon,
  filterTree,
  listedIdsFrom,
  onlyListed,
  settledKeys,
  withPendingCreates,
} from './tree-view';

/** Ids as a nested outline; a node with no known children is its bare id. */
const outline = (nodes: readonly FileNode[]): unknown[] =>
  nodes.map((node) => (node.children === undefined ? node.id : [node.id, outline(node.children)]));

/**
 * Drive d1:
 *   Launch (folder) › Brief (doc) › Notes (doc)
 *                   › Roadmap (sheet)
 *   Archive (folder, empty)
 *   Readme (doc)
 */
const pages = [
  treeRow('launch', 'FOLDER', [
    treeRow('brief', 'DOCUMENT', [treeRow('notes', 'DOCUMENT', [], { parentId: 'brief', title: 'Notes' })], {
      parentId: 'launch',
      title: 'Brief',
    }),
    treeRow('roadmap', 'SHEET', [], { parentId: 'launch', title: 'Roadmap', position: 1 }),
  ], { title: 'Launch' }),
  treeRow('archive', 'FOLDER', [], { title: 'Archive', position: 1 }),
  treeRow('readme', 'DOCUMENT', [], { title: 'Readme', position: 2 }),
];
const nodes = fileNodesFrom(pages);

const pending = (key: string, overrides: Partial<PendingFile> = {}): PendingFile => ({
  key,
  driveId: 'd1',
  parentId: 'archive',
  title: 'Untitled Document',
  pageId: null,
  knownIds: [],
  ...overrides,
});

describe('fileIcon()', () => {
  test('every page type', () => {
    assert({
      given: 'each PageSpace page type',
      should: 'draw it with the glyph classic gives that type',
      actual: (['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'FILE', 'SHEET', 'TASK_LIST', 'CODE'] as const).map(
        fileIcon,
      ),
      expected: ['folder', 'page', 'messages', 'bot', 'canvas', 'file', 'sheet', 'tasks', 'code'],
    });
  });
});

describe('listedIdsFrom() and onlyListed()', () => {
  test('the drive tree lists every page it nests', () => {
    assert({
      given: 'the drive tree',
      should: 'list every page at every depth',
      actual: [...listedIdsFrom(pages)].sort(),
      expected: ['archive', 'brief', 'launch', 'notes', 'readme', 'roadmap'],
    });
  });

  test('a page only a children load named', () => {
    const extra = fileNodesFrom([
      treeRow('archive', 'FOLDER', [treeRow('hidden', 'DOCUMENT', [], { parentId: 'archive' })]),
      treeRow('readme', 'DOCUMENT'),
    ]);
    assert({
      given: 'a children load naming a page the drive tree does not list',
      should: 'leave that page out and keep the listed ones',
      actual: outline(onlyListed(extra, listedIdsFrom(pages))),
      expected: [['archive', []], 'readme'],
    });
  });

  test('nothing to drop', () => {
    assert({
      given: 'a tree the drive tree lists in full',
      should: 'answer the same nodes',
      actual: onlyListed(nodes, listedIdsFrom(pages)) === nodes,
      expected: true,
    });
  });
});

describe('filterTree()', () => {
  test('no filter', () => {
    assert({
      given: 'an empty or blank filter',
      should: 'answer the tree as it is',
      actual: [filterTree(nodes, '') === nodes, filterTree(nodes, '   ') === nodes],
      expected: [true, true],
    });
  });

  test('a deep match keeps its ancestors', () => {
    assert({
      given: 'a filter matching only a page two levels down',
      should: 'keep the match and the folders above it, and nothing else',
      actual: outline(filterTree(nodes, 'NOTES')),
      expected: [['launch', [['brief', ['notes']]]]],
    });
  });

  test('a matching parent keeps what it holds', () => {
    assert({
      given: 'a filter matching a folder by name',
      should: 'keep the folder with everything under it',
      actual: outline(filterTree(nodes, 'launch')),
      expected: [['launch', [['brief', ['notes']], 'roadmap']]],
    });
  });

  test('no match', () => {
    assert({
      given: 'a filter nothing matches',
      should: 'leave no rows',
      actual: filterTree(nodes, 'zebra'),
      expected: [],
    });
  });
});

describe('disclosableIds()', () => {
  test('pages holding pages', () => {
    assert({
      given: 'a filtered tree',
      should: 'name every page that holds a kept page, so the matches show',
      actual: disclosableIds(filterTree(nodes, 'notes')),
      expected: ['launch', 'brief'],
    });
  });
});

describe('createParentFor()', () => {
  test('where + puts the page', () => {
    assert({
      given: 'no selection, a selected folder, a selected page inside a folder, a top-level page, and an unknown id',
      should: 'create at the top, in the folder, beside the page, at the top, and at the top',
      actual: [
        createParentFor(nodes, null),
        createParentFor(nodes, 'archive'),
        createParentFor(nodes, 'roadmap'),
        createParentFor(nodes, 'readme'),
        createParentFor(nodes, 'nope'),
      ],
      expected: [null, 'archive', 'launch', null, null],
    });
  });
});

describe('childIdsOf()', () => {
  test('what a parent holds', () => {
    assert({
      given: 'the top of the drive, a folder, an empty folder and an unknown page',
      should: 'name the ids under each',
      actual: [childIdsOf(nodes, null), childIdsOf(nodes, 'launch'), childIdsOf(nodes, 'archive'), childIdsOf(nodes, 'nope')],
      expected: [['launch', 'archive', 'readme'], ['brief', 'roadmap'], [], []],
    });
  });
});

describe('withPendingCreates()', () => {
  test('nothing pending', () => {
    const shown = withPendingCreates(nodes, [], 'd1');
    assert({
      given: 'no create in flight',
      should: 'answer the tree as it is, with no pending rows',
      actual: [shown.nodes === nodes, shown.pendingIds],
      expected: [true, []],
    });
  });

  test('a create in flight', () => {
    const shown = withPendingCreates(nodes, [pending('tmp-1')], 'd1');
    const archive = shown.nodes.find((node) => node.id === 'archive');
    assert({
      given: 'a document being created in the empty Archive folder',
      should: 'show it under Archive as a pending page, and count it',
      actual: [outline(shown.nodes), archive?.count, archive?.children?.[0], shown.pendingIds],
      expected: [
        [['launch', [['brief', ['notes']], 'roadmap']], ['archive', ['tmp-1']], 'readme'],
        1,
        { id: 'tmp-1', name: 'Untitled Document', kind: 'page', pageType: 'DOCUMENT' },
        ['tmp-1'],
      ],
    });
  });

  test('at the top, under a page with no children yet, and in another drive', () => {
    const shown = withPendingCreates(
      nodes,
      [
        pending('tmp-1', { parentId: null }),
        pending('tmp-2', { parentId: 'readme' }),
        pending('tmp-3', { driveId: 'd2', parentId: null }),
      ],
      'd1',
    );
    assert({
      given: 'creates at the top of d1, under a leaf page, and in d2',
      should: 'add the first two where they were asked for and leave d2’s out',
      actual: outline(shown.nodes),
      expected: [['launch', [['brief', ['notes']], 'roadmap']], ['archive', []], ['readme', ['tmp-2']], 'tmp-1'],
    });
  });

  test('the server answered', () => {
    const shown = withPendingCreates(nodes, [pending('tmp-1', { pageId: 'p9' })], 'd1');
    assert({
      given: 'a create the server answered as p9, before the tree lists it',
      should: 'show it by its server id, so the opened page is the selected row',
      actual: [outline(shown.nodes)[1], shown.pendingIds],
      expected: [['archive', ['p9']], ['p9']],
    });
  });

  test('the tree lists the answered page', () => {
    const listed = fileNodesFrom([
      treeRow('archive', 'FOLDER', [treeRow('p9', 'DOCUMENT', [], { parentId: 'archive', title: 'Untitled Document' })]),
    ]);
    const shown = withPendingCreates(listed, [pending('tmp-1', { pageId: 'p9' })], 'd1');
    assert({
      given: 'the server’s page already in the tree',
      should: 'draw it once, from the tree',
      actual: [outline(shown.nodes), shown.pendingIds],
      expected: [[['archive', ['p9']]], []],
    });
  });

  test('the tree lists it before the create answers', () => {
    const listed = fileNodesFrom([
      treeRow('archive', 'FOLDER', [
        treeRow('old', 'DOCUMENT', [], { parentId: 'archive', title: 'Untitled Document' }),
        treeRow('p9', 'DOCUMENT', [], { parentId: 'archive', title: 'Untitled Document', position: 1 }),
      ]),
    ]);
    const shown = withPendingCreates(
      listed,
      [pending('tmp-1', { knownIds: ['old'] }), pending('tmp-2', { knownIds: ['old'] })],
      'd1',
    );
    assert({
      given: 'two creates in flight and a socket revalidation that already lists one new page',
      should: 'let the listed page stand for one create and keep a pending row only for the other',
      actual: [outline(shown.nodes), shown.pendingIds],
      expected: [[['archive', ['old', 'p9', 'tmp-2']]], ['tmp-2']],
    });
  });

  test('a page answered to another create is not this one', () => {
    const listed = fileNodesFrom([
      treeRow('archive', 'FOLDER', [treeRow('p9', 'DOCUMENT', [], { parentId: 'archive', title: 'Untitled Document' })]),
    ]);
    const shown = withPendingCreates(
      listed,
      [pending('tmp-1', { pageId: 'p9' }), pending('tmp-2')],
      'd1',
    );
    assert({
      given: 'p9 listed and named as the first create’s page, and a second create in flight',
      should: 'keep the second create’s row',
      actual: outline(shown.nodes),
      expected: [['archive', ['p9', 'tmp-2']]],
    });
  });

  test('the parent is gone', () => {
    const shown = withPendingCreates(nodes, [pending('tmp-1', { parentId: 'trashed' })], 'd1');
    assert({
      given: 'a create under a page the tree no longer holds',
      should: 'draw no row for it',
      actual: [shown.nodes === nodes, shown.pendingIds],
      expected: [true, []],
    });
  });
});

describe('settledKeys()', () => {
  test('creates the tree lists', () => {
    assert({
      given: 'an unanswered create, an answered one the tree lists, one it does not yet, and another drive’s',
      should: 'settle only the answered create the tree lists',
      actual: settledKeys(
        [
          pending('tmp-1'),
          pending('tmp-2', { pageId: 'readme' }),
          pending('tmp-3', { pageId: 'p9' }),
          pending('tmp-4', { pageId: 'readme', driveId: 'd2' }),
        ],
        listedIdsFrom(pages),
        'd1',
      ),
      expected: ['tmp-2'],
    });
  });
});
