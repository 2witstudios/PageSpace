import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, parent, task } from '../task-model/fixtures';
import { chipCounts, filterTree, isFiltering, noFilter, openedForMatches } from './task-filter';

const context = { viewerId: 'u-me', today: '2026-10-18' };
const me = [{ type: 'user' as const, id: 'u-me', name: 'Me' }];

const tree = list('root', [
  parent('p', [
    task('a', { title: 'Write copy', assignees: me }),
    task('b', { title: 'Book room', dueDate: '2026-10-16T00:00:00.000Z' }),
  ]),
  task('c', { title: 'Ship it', dueDate: '2026-10-16T00:00:00.000Z', status: 'completed', completedAt: '2026-10-17T00:00:00.000Z' }),
  task('d', { title: 'Copy review' }),
]);

const ids = (level: { readonly tasks: readonly { readonly id: string; readonly subtasks: { readonly tasks: readonly unknown[] } | null }[] }): unknown =>
  level.tasks.map((entry) => (entry.subtasks === null ? entry.id : [entry.id, ids(entry.subtasks as never)]));

describe('filterTree', () => {
  test('no filter', () => {
    assert({
      given: 'the All chip and no query',
      should: 'return the very same list',
      actual: filterTree(tree, noFilter, context) === tree,
      expected: true,
    });
  });

  test('mine keeps the parent', () => {
    assert({
      given: 'the Mine chip and a match only under a parent',
      should: 'keep the parent with only the branch that matches',
      actual: ids(filterTree(tree, { chip: 'mine', query: '' }, context)),
      expected: [['p', ['a']]],
    });
  });

  test('overdue skips done', () => {
    assert({
      given: 'the Overdue chip, one late open task and one late done task',
      should: 'keep only the open one, under its parent',
      actual: ids(filterTree(tree, { chip: 'overdue', query: '' }, context)),
      expected: [['p', ['b']]],
    });
  });

  test('query', () => {
    assert({
      given: 'a query in another case with spaces round it',
      should: 'match titles at every level',
      actual: ids(filterTree(tree, { chip: 'all', query: '  COPY ' }, context)),
      expected: [['p', ['a']], 'd'],
    });
  });
});

describe('chipCounts', () => {
  test('every level', () => {
    assert({
      given: 'a tree with a nested assignment and a late subtask',
      should: 'count every loaded task for each chip',
      actual: chipCounts(tree, context),
      expected: { all: 5, mine: 1, overdue: 1 },
    });
  });
});

describe('isFiltering', () => {
  test('whitespace query', () => {
    assert({
      given: 'the All chip and a query of spaces',
      should: 'not count as filtering',
      actual: isFiltering({ chip: 'all', query: '   ' }),
      expected: false,
    });
  });
});

describe('openedForMatches', () => {
  test('parents with kept children', () => {
    assert({
      given: 'a filtered tree with one kept parent',
      should: 'open that parent',
      actual: openedForMatches(filterTree(tree, { chip: 'mine', query: '' }, context)),
      expected: ['p'],
    });
  });
});
