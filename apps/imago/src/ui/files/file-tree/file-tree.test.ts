import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { composeTree, mergeChildren } from './file-tree';
import { pageRow, treeRow } from '../file-model/fixtures';
import type { PageTreeResponse } from '../file-model/file-node';

/** Ids as a nested outline, `children` marked unknown with '?'. */
const outline = (pages: readonly PageTreeResponse[]): unknown[] =>
  pages.map((page) => (page.children === undefined ? `${page.id}?` : [page.id, outline(page.children)]));

const drive = (): readonly PageTreeResponse[] => [
  treeRow('f1', 'FOLDER', [treeRow('a', 'DOCUMENT', [treeRow('a1', 'DOCUMENT')]), treeRow('b', 'SHEET')]),
  treeRow('f2', 'FOLDER', [treeRow('n', 'FOLDER')]),
];

describe('mergeChildren()', () => {
  test('a folder’s children loaded', () => {
    const children = [pageRow('a', 'DOCUMENT', { parentId: 'f1' }), pageRow('c', 'CODE', { parentId: 'f1', position: 2 })];

    assert({
      given: 'a folder’s children loaded from the children route (one kept, one gone, one new)',
      should: 'make them the folder’s children, keeping what is known below a kept child',
      actual: outline(mergeChildren(drive(), 'f1', children)),
      expected: [
        ['f1', [['a', [['a1', []]]], 'c?']],
        ['f2', [['n', []]]],
      ],
    });
  });

  test('a nested parent', () => {
    assert({
      given: 'children loaded for a folder inside another folder',
      should: 'place them under that folder',
      actual: outline(mergeChildren(drive(), 'n', [pageRow('x', 'DOCUMENT', { parentId: 'n' })])),
      expected: [
        ['f1', [['a', [['a1', []]]], ['b', []]]],
        ['f2', [['n', ['x?']]]],
      ],
    });
  });

  test('order', () => {
    const children = [
      pageRow('late', 'DOCUMENT', { parentId: 'n', position: 5 }),
      pageRow('early', 'DOCUMENT', { parentId: 'n', position: 1 }),
    ];

    assert({
      given: 'loaded children out of position order',
      should: 'order them by position',
      actual: outline(mergeChildren(drive(), 'n', children))[1],
      expected: ['f2', [['n', ['early?', 'late?']]]],
    });
  });

  test('a parent whose children were not known', () => {
    const pages = mergeChildren(drive(), 'f1', [pageRow('c', 'FOLDER', { parentId: 'f1' })]);

    assert({
      given: 'children loaded for a page whose own children were not known yet',
      should: 'place them under it',
      actual: outline(mergeChildren(pages, 'c', [pageRow('x', 'DOCUMENT', { parentId: 'c' })]))[0],
      expected: ['f1', [['c', ['x?']]]],
    });
  });

  test('a parent the tree does not hold', () => {
    const pages = drive();

    assert({
      given: 'children for a page that is not in the tree (moved or trashed since)',
      should: 'return the same tree untouched',
      actual: mergeChildren(pages, 'missing', [pageRow('x', 'DOCUMENT')]) === pages,
      expected: true,
    });
  });

  test('pure', () => {
    const pages = drive();
    const before = JSON.stringify(pages);
    mergeChildren(pages, 'f1', []);

    assert({
      given: 'a tree merged into a new one',
      should: 'leave the old tree untouched',
      actual: JSON.stringify(pages),
      expected: before,
    });
  });
});

describe('composeTree()', () => {
  test('children loaded after the tree', () => {
    const tree = { pages: drive(), at: 1 };
    const loaded = { n: { children: [pageRow('x', 'DOCUMENT')], at: 2 } };

    assert({
      given: 'children loaded after the drive tree was fetched',
      should: 'show them under their parent',
      actual: outline(composeTree(tree, loaded))[1],
      expected: ['f2', [['n', ['x?']]]],
    });
  });

  test('children older than the tree', () => {
    const tree = { pages: drive(), at: 3 };
    const loaded = { n: { children: [pageRow('x', 'DOCUMENT')], at: 2 } };

    assert({
      given: 'a drive tree fetched after the children were (a socket event revalidated it)',
      should: 'show the newer drive tree as it is',
      actual: outline(composeTree(tree, loaded)),
      expected: outline(drive()),
    });
  });

  test('several loads', () => {
    const tree = { pages: drive(), at: 1 };
    const loaded = {
      f2: { children: [pageRow('n', 'FOLDER')], at: 2 },
      n: { children: [pageRow('x', 'DOCUMENT')], at: 3 },
    };

    assert({
      given: 'a folder loaded and then a folder inside it',
      should: 'apply both, outermost first',
      actual: outline(composeTree(tree, loaded))[1],
      expected: ['f2', [['n', ['x?']]]],
    });
  });

  test('nothing loaded', () => {
    const pages = drive();

    assert({
      given: 'no children loaded',
      should: 'give the drive tree itself',
      actual: composeTree({ pages, at: 1 }, {}) === pages,
      expected: true,
    });
  });
});
