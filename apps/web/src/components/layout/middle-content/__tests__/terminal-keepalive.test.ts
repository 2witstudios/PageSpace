import { describe, it } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';
import {
  planMountedTerminals,
  collectTerminalPageIds,
  type TerminalTreeNode,
} from '../terminal-keepalive';

describe('planMountedTerminals', () => {
  it('given no active terminal and no history, should mount nothing', () => {
    assert({
      given: 'no active terminal and an empty history',
      should: 'mount nothing',
      actual: planMountedTerminals({ current: null, visited: [], max: 3 }),
      expected: [],
    });
  });

  it('given a first-visited terminal, should mount it', () => {
    assert({
      given: 'a terminal becoming active with no prior history',
      should: 'mount just that terminal',
      actual: planMountedTerminals({ current: 'a', visited: [], max: 3 }),
      expected: ['a'],
    });
  });

  it('given the active terminal already in history, should pin it to the front without duplicating', () => {
    assert({
      given: 'the active terminal already present in the visited set',
      should: 'move it to the front and keep it unique',
      actual: planMountedTerminals({ current: 'b', visited: ['a', 'b', 'c'], max: 3 }),
      expected: ['b', 'a', 'c'],
    });
  });

  it('given a new active terminal beyond the bound, should evict the least-recently-used', () => {
    assert({
      given: 'a fourth distinct terminal with a bound of 3',
      should: 'keep the 3 most-recent and evict the oldest',
      actual: planMountedTerminals({ current: 'd', visited: ['c', 'b', 'a'], max: 3 }),
      expected: ['d', 'c', 'b'],
    });
  });

  it('given navigation to a non-terminal page, should keep the mounted set intact (no active pin)', () => {
    assert({
      given: 'a null current (active page is not a terminal)',
      should: 'preserve the existing mounted set unchanged',
      actual: planMountedTerminals({ current: null, visited: ['c', 'b', 'a'], max: 3 }),
      expected: ['c', 'b', 'a'],
    });
  });

  it('given a trashed terminal absent from the valid set, should evict it', () => {
    assert({
      given: 'a mounted terminal that no longer exists in the tree',
      should: 'drop it from the mounted set',
      actual: planMountedTerminals({
        current: null,
        visited: ['c', 'b', 'a'],
        max: 3,
        valid: new Set(['c', 'a']),
      }),
      expected: ['c', 'a'],
    });
  });

  it('given the active terminal absent from the valid set, should still pin it (it is being viewed)', () => {
    assert({
      given: 'an active terminal briefly missing from a stale valid set',
      should: 'retain the active terminal despite the valid filter',
      actual: planMountedTerminals({
        current: 'd',
        visited: ['a'],
        max: 3,
        valid: new Set(['a']),
      }),
      expected: ['d', 'a'],
    });
  });

  it('given a bound of zero with an active terminal, should still keep the active one pinned', () => {
    assert({
      given: 'max=0 but an active terminal',
      should: 'keep the active terminal (pin overrides the bound)',
      actual: planMountedTerminals({ current: 'a', visited: ['b'], max: 0 }),
      expected: ['a'],
    });
  });

  it('given repeated ids in history, should de-duplicate preserving MRU order', () => {
    assert({
      given: 'a visited set containing duplicates',
      should: 'collapse duplicates keeping first (most-recent) occurrence',
      actual: planMountedTerminals({ current: 'a', visited: ['a', 'b', 'a', 'c'], max: 5 }),
      expected: ['a', 'b', 'c'],
    });
  });
});

describe('collectTerminalPageIds', () => {
  const tree: TerminalTreeNode[] = [
    {
      id: 'root',
      type: 'FOLDER',
      children: [
        { id: 't1', type: 'TERMINAL' },
        {
          id: 'doc',
          type: 'DOCUMENT',
          children: [{ id: 't2', type: 'TERMINAL' }],
        },
      ],
    },
    { id: 't3', type: 'TERMINAL', children: [] },
  ];

  it('given a nested tree, should collect every terminal id at any depth', () => {
    assert({
      given: 'a tree with terminals nested under non-terminal pages',
      should: 'return all terminal ids',
      actual: collectTerminalPageIds(tree).sort(),
      expected: ['t1', 't2', 't3'],
    });
  });

  it('given an empty or nullish tree, should return an empty list', () => {
    assert({
      given: 'a null tree',
      should: 'return no ids',
      actual: collectTerminalPageIds(null),
      expected: [],
    });
  });
});
