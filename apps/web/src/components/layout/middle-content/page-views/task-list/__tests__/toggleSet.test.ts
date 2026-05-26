import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { toggleSet } from '../TaskListView';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('toggleSet', () => {
  it('adds an id not in the set', () => {
    assert({
      given: 'a set that does not contain the id',
      should: 'return a new set containing the id',
      actual: toggleSet(new Set(['a']), 'b').has('b'),
      expected: true,
    });
  });

  it('removes an id already in the set', () => {
    assert({
      given: 'a set that already contains the id',
      should: 'return a new set without the id',
      actual: toggleSet(new Set(['a', 'b']), 'a').has('a'),
      expected: false,
    });
  });

  it('leaves other ids untouched when adding', () => {
    assert({
      given: 'a set with existing ids when adding a new one',
      should: 'preserve all existing ids',
      actual: toggleSet(new Set(['a', 'b']), 'c').has('a'),
      expected: true,
    });
  });

  it('leaves other ids untouched when removing', () => {
    assert({
      given: 'a set with multiple ids when removing one',
      should: 'not affect the remaining ids',
      actual: toggleSet(new Set(['a', 'b']), 'a').has('b'),
      expected: true,
    });
  });

  it('does not mutate the input set', () => {
    const original = new Set(['a']);
    toggleSet(original, 'b');
    assert({
      given: 'the original set after a toggle',
      should: 'remain unchanged (pure function)',
      actual: original.size,
      expected: 1,
    });
  });
});
