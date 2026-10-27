import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { changedPages, describeChanges, pageTitlesOf } from './member-permission-changes';

const on = { canView: true, canEdit: false, canShare: false };
const off = { canView: false, canEdit: false, canShare: false };

describe('changedPages()', () => {
  test('a page with no saved row counts as all off, so turning View on is a change and matching the saved state is not', () => {
    const saved = new Map([['p1', on]]);
    const current = new Map([
      ['p1', { ...on }],
      ['p2', on],
      ['p3', off],
    ]);
    assert({
      given: 'a saved page that is unchanged, a new page given View, and a page set to all off with no saved row',
      should: 'report only the page whose access differs, named from the tree',
      actual: changedPages(saved, current, new Map([['p2', 'Pricing Model']])),
      expected: [{ pageId: 'p2', title: 'Pricing Model' }],
    });
  });

  test('a page whose access went back to saved is no longer a change', () => {
    assert({
      given: 'an edit undone back to the saved access',
      should: 'report no changes',
      actual: changedPages(new Map([['p1', on]]), new Map([['p1', { ...on }]]), new Map()),
      expected: [],
    });
  });
});

describe('describeChanges()', () => {
  test('names one, two or more changed pages', () => {
    const change = (title: string) => ({ pageId: title, title });
    assert({
      given: 'one, two and four changed pages',
      should: 'name them, collapsing the rest into a count',
      actual: [
        describeChanges([change('Pricing Model')]),
        describeChanges([change('Pricing Model'), change('launch-ops')]),
        describeChanges(['A', 'B', 'C', 'D'].map(change)),
      ],
      expected: [
        '1 permission change on Pricing Model',
        '2 permission changes on Pricing Model and launch-ops',
        '4 permission changes on A, B and 2 more',
      ],
    });
  });
});

describe('pageTitlesOf()', () => {
  test('flattens the tree into id to title, children included', () => {
    assert({
      given: 'a page tree with a folder and a child',
      should: 'map every node id to its title',
      actual: [...pageTitlesOf([{ id: 'f', title: 'Folder', children: [{ id: 'c', title: 'Child', children: [] }] }]).entries()],
      expected: [
        ['f', 'Folder'],
        ['c', 'Child'],
      ],
    });
  });
});
