import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { PAGE_TYPE_VALUES } from '@pagespace/lib/client-safe';
import { pages } from '@pagespace/db/schema/core';
import { fileNodesFrom } from './from-api';
import { pageRow, treeRow } from './fixtures';
import type { PageResponse } from './file-node';

/** When every fixture row last changed. */
const AT = '2026-10-01T00:00:00.000Z';

describe('PageResponse', () => {
  test('parity with the pages table', () => {
    // Both routes answer whole pages rows; a column renamed there fails here.
    const read: Record<keyof PageResponse, true> = {
      id: true,
      title: true,
      type: true,
      parentId: true,
      position: true,
      isTrashed: true,
      updatedAt: true,
    };

    assert({
      given: 'the fields imago reads from a page row',
      should: 'each be a column of the pages table',
      actual: Object.keys(read).filter((field) => !(field in pages)),
      expected: [],
    });
  });

  test('parity with the page types', () => {
    assert({
      given: 'the page types a pages row can hold',
      should: 'be the ones imago maps, besides MACHINE, whose rows migration 0234 deleted (Postgres cannot drop an enum value)',
      actual: pages.type.enumValues.filter((type) => type !== 'MACHINE'),
      expected: PAGE_TYPE_VALUES,
    });
  });
});

describe('fileNodesFrom()', () => {
  test('a folder and its pages', () => {
    const tree = [
      treeRow('f1', 'FOLDER', [treeRow('doc', 'DOCUMENT'), treeRow('sheet', 'SHEET')], { title: 'Specs' }),
    ];

    assert({
      given: 'a drive tree with a folder holding a document and a sheet',
      should: 'map it to a folder node counting its pages, each keeping its title and page type',
      actual: fileNodesFrom(tree),
      expected: [
        {
          id: 'f1',
          name: 'Specs',
          kind: 'folder',
          pageType: 'FOLDER', updatedAt: AT,
          count: 2,
          children: [
            { id: 'doc', name: 'Title doc', kind: 'page', pageType: 'DOCUMENT', updatedAt: AT },
            { id: 'sheet', name: 'Title sheet', kind: 'page', pageType: 'SHEET', updatedAt: AT },
          ],
        },
      ],
    });
  });

  test('every page type', () => {
    const tree = PAGE_TYPE_VALUES.map((type) => treeRow(type, type));

    assert({
      given: 'one page of each PageSpace page type',
      should: 'open only FOLDER as a folder and keep every page type on its node',
      actual: fileNodesFrom(tree).map(({ kind, pageType }) => [pageType, kind]),
      expected: [
        ['FOLDER', 'folder'],
        ['DOCUMENT', 'page'],
        ['CHANNEL', 'page'],
        ['AI_CHAT', 'page'],
        ['CANVAS', 'page'],
        ['FILE', 'page'],
        ['SHEET', 'page'],
        ['TASK_LIST', 'page'],
        ['CODE', 'page'],
      ],
    });
  });

  test('an empty folder', () => {
    assert({
      given: 'a folder the tree shows with no children',
      should: 'carry an empty children list and a zero count',
      actual: fileNodesFrom([treeRow('f1', 'FOLDER')]),
      expected: [{ id: 'f1', name: 'Title f1', kind: 'folder', pageType: 'FOLDER', updatedAt: AT, count: 0, children: [] }],
    });
  });

  test('pages under a page', () => {
    const tree = [treeRow('doc', 'DOCUMENT', [treeRow('sub', 'CANVAS', [treeRow('deep', 'CODE')])])];

    assert({
      given: 'a document holding a canvas that holds a code page',
      should: 'nest them under the document without making it a folder',
      actual: fileNodesFrom(tree),
      expected: [
        {
          id: 'doc',
          name: 'Title doc',
          kind: 'page',
          pageType: 'DOCUMENT', updatedAt: AT,
          children: [
            {
              id: 'sub',
              name: 'Title sub',
              kind: 'page',
              pageType: 'CANVAS', updatedAt: AT,
              children: [{ id: 'deep', name: 'Title deep', kind: 'page', pageType: 'CODE', updatedAt: AT }],
            },
          ],
        },
      ],
    });
  });

  test('children not known yet', () => {
    const rows = [pageRow('f2', 'FOLDER'), pageRow('doc', 'DOCUMENT')];

    assert({
      given: 'rows from the children route, which carry no children of their own',
      should: 'leave children and count off, so a view knows to load them rather than show an empty folder',
      actual: fileNodesFrom(rows),
      expected: [
        { id: 'f2', name: 'Title f2', kind: 'folder', pageType: 'FOLDER', updatedAt: AT },
        { id: 'doc', name: 'Title doc', kind: 'page', pageType: 'DOCUMENT', updatedAt: AT },
      ],
    });
  });

  test('trashed pages', () => {
    const tree = [
      treeRow('f1', 'FOLDER', [treeRow('kept', 'DOCUMENT'), treeRow('gone', 'DOCUMENT', [], { isTrashed: true })]),
      treeRow('binned', 'SHEET', [], { isTrashed: true }),
    ];

    assert({
      given: 'trashed rows at the top and inside a folder',
      should: 'leave them out, as the server does, and count only what is left',
      actual: fileNodesFrom(tree),
      expected: [
        {
          id: 'f1',
          name: 'Title f1',
          kind: 'folder',
          pageType: 'FOLDER', updatedAt: AT,
          count: 1,
          children: [{ id: 'kept', name: 'Title kept', kind: 'page', pageType: 'DOCUMENT', updatedAt: AT }],
        },
      ],
    });
  });

  test('order', () => {
    const tree = [
      treeRow('b', 'DOCUMENT', [], { position: 1 }),
      treeRow('a', 'DOCUMENT', [], { position: 2 }),
      treeRow('c', 'DOCUMENT', [], { position: 0 }),
    ];

    assert({
      given: 'siblings out of position order',
      should: 'order them by position, as the sidebar shows them',
      actual: fileNodesFrom(tree).map((node) => node.id),
      expected: ['c', 'b', 'a'],
    });
  });

  test('an empty drive', () => {
    assert({
      given: 'a drive with no pages the viewer can see',
      should: 'give no nodes',
      actual: fileNodesFrom([]),
      expected: [],
    });
  });
});

describe('fileNodesFrom() times', () => {
  test('when each page last changed', () => {
    const tree = [
      treeRow('f1', 'FOLDER', [treeRow('doc', 'DOCUMENT', [], { updatedAt: '2026-10-05T09:12:00.000Z' })], {
        updatedAt: '2026-09-18T10:00:00.000Z',
      }),
    ];

    assert({
      given: 'a folder and a page that changed at different times',
      should: 'carry each page’s own updatedAt on its node, for the folder browser’s Modified column',
      actual: [fileNodesFrom(tree)[0]?.updatedAt, fileNodesFrom(tree)[0]?.children?.[0]?.updatedAt],
      expected: ['2026-09-18T10:00:00.000Z', '2026-10-05T09:12:00.000Z'],
    });
  });
});
