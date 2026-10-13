import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { FileNode } from '../file-model/file-node';
import { ariaSortOf, DEFAULT_SORT, nextSort, sortNodes } from './files-browser-sort';

const node = (id: string, name: string, pageType: FileNode['pageType'], updatedAt?: string): FileNode => ({
  id,
  name,
  kind: 'page',
  pageType,
  updatedAt,
});

const launch = [
  node('plan', 'Q4 Launch Plan', 'DOCUMENT', '2026-10-12T09:00:00.000Z'),
  node('agent', 'Launch Agent', 'AI_CHAT', '2026-10-02T09:00:00.000Z'),
  node('pricing', 'Pricing Model', 'SHEET', '2026-10-12T11:00:00.000Z'),
  node('calc', 'pricing-calc.ts', 'CODE', '2026-10-08T09:00:00.000Z'),
];

const names = (nodes: readonly FileNode[]) => nodes.map((entry) => entry.name);

describe('sortNodes()', () => {
  test('the default sort', () => {
    assert({
      given: 'no column chosen yet',
      should: 'sort by name, A to Z',
      actual: [DEFAULT_SORT.key, DEFAULT_SORT.dir, names(sortNodes(launch, DEFAULT_SORT))],
      expected: ['title', 'asc', ['Launch Agent', 'Pricing Model', 'Q4 Launch Plan', 'pricing-calc.ts']],
    });
  });

  test('name descending', () => {
    assert({
      given: 'the Name column sorted descending',
      should: 'reverse the name order',
      actual: names(sortNodes(launch, { key: 'title', dir: 'desc' })),
      expected: ['pricing-calc.ts', 'Q4 Launch Plan', 'Pricing Model', 'Launch Agent'],
    });
  });

  test('the same comparator as apps/web: capitals sort before lowercase', () => {
    assert({
      given: 'a lowercase name and a capitalised one',
      should: 'compare by plain code units, so the capital comes first in ascending order',
      actual: names(sortNodes([node('a', 'alpha', 'DOCUMENT'), node('b', 'Beta', 'DOCUMENT')], DEFAULT_SORT)),
      expected: ['Beta', 'alpha'],
    });
  });

  test('last modified, both ways', () => {
    assert({
      given: 'the Last Modified column',
      should: 'order by when each page last changed, oldest first ascending',
      actual: [
        names(sortNodes(launch, { key: 'updatedAt', dir: 'asc' })),
        names(sortNodes(launch, { key: 'updatedAt', dir: 'desc' })),
      ],
      expected: [
        ['Launch Agent', 'pricing-calc.ts', 'Q4 Launch Plan', 'Pricing Model'],
        ['Pricing Model', 'Q4 Launch Plan', 'pricing-calc.ts', 'Launch Agent'],
      ],
    });
  });

  test('type sorts by the page type value', () => {
    assert({
      given: 'the Type column ascending',
      should: 'order by the page type value (AI_CHAT, CODE, DOCUMENT, SHEET)',
      actual: names(sortNodes(launch, { key: 'type', dir: 'asc' })),
      expected: ['Launch Agent', 'pricing-calc.ts', 'Q4 Launch Plan', 'Pricing Model'],
    });
  });

  test('a page with no time yet sorts as empty, and the input is left alone', () => {
    const pending = [node('new', 'New', 'DOCUMENT'), ...launch];
    const before = names(pending);
    const sorted = sortNodes(pending, { key: 'updatedAt', dir: 'asc' });
    assert({
      given: 'a create still in flight with no updated time',
      should: 'put it first in ascending order and never change the list it was given',
      actual: [names(sorted)[0], names(pending) .join() === before.join()],
      expected: ['New', true],
    });
  });
});

describe('nextSort()', () => {
  test('a column clicked again flips its direction; another column starts ascending', () => {
    assert({
      given: 'the browser sorted by name ascending',
      should: 'flip to descending on the same column, and start a new column ascending',
      actual: [
        nextSort(DEFAULT_SORT, 'title'),
        nextSort({ key: 'title', dir: 'desc' }, 'title'),
        nextSort(DEFAULT_SORT, 'updatedAt'),
      ],
      expected: [
        { key: 'title', dir: 'desc' },
        { key: 'title', dir: 'asc' },
        { key: 'updatedAt', dir: 'asc' },
      ],
    });
  });
});

describe('ariaSortOf()', () => {
  test('the header carries the sort it is in', () => {
    assert({
      given: 'a browser sorted by Last Modified descending',
      should: 'mark that column descending and the others none',
      actual: [
        ariaSortOf({ key: 'updatedAt', dir: 'desc' }, 'updatedAt'),
        ariaSortOf({ key: 'updatedAt', dir: 'desc' }, 'title'),
        ariaSortOf({ key: 'title', dir: 'asc' }, 'title'),
      ],
      expected: ['descending', 'none', 'ascending'],
    });
  });
});
