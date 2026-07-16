import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { deepEqual } from '../deep-equal';

describe('deepEqual — reference / primitive identity', () => {
  it('treats strictly-equal primitives as equal', () => {
    assert({
      given: 'two identical numbers',
      should: 'return true via the fast path',
      actual: deepEqual(5, 5),
      expected: true,
    });
  });

  it('distinguishes different primitives', () => {
    assert({
      given: 'two different numbers',
      should: 'return false',
      actual: deepEqual(1, 2),
      expected: false,
    });
  });

  it('distinguishes different-typed primitives', () => {
    assert({
      given: 'a number and its string form',
      should: 'return false (no coercion)',
      actual: deepEqual(1, '1'),
      expected: false,
    });
  });

  it('compares signed zero as equal (=== semantics retained)', () => {
    assert({
      given: '0 and -0',
      should: 'return true so numeric zero never spuriously conflicts',
      actual: deepEqual(0, -0),
      expected: true,
    });
  });
});

describe('deepEqual — NaN (deliberate Object.is-style change)', () => {
  it('treats NaN as equal to NaN', () => {
    assert({
      given: 'NaN on both sides',
      should: 'return true so a NaN-valued field cannot perpetually conflict',
      actual: deepEqual(NaN, NaN),
      expected: true,
    });
  });

  it('keeps NaN distinct from a real number', () => {
    assert({
      given: 'NaN and a real number',
      should: 'return false',
      actual: deepEqual(NaN, 3),
      expected: false,
    });
  });

  it('treats a nested NaN field as equal', () => {
    assert({
      given: 'two objects whose only field is NaN',
      should: 'return true',
      actual: deepEqual({ score: NaN }, { score: NaN }),
      expected: true,
    });
  });
});

describe('deepEqual — null / undefined', () => {
  it('treats null as equal to null', () => {
    assert({
      given: 'null on both sides',
      should: 'return true',
      actual: deepEqual(null, null),
      expected: true,
    });
  });

  it('treats null and undefined as different', () => {
    assert({
      given: 'null vs undefined',
      should: 'return false',
      actual: deepEqual(undefined, null),
      expected: false,
    });
  });

  it('treats null and a value as different', () => {
    assert({
      given: 'null vs a value (left null guard)',
      should: 'return false',
      actual: deepEqual(null, 5),
      expected: false,
    });
  });

  it('treats a value and null as different', () => {
    assert({
      given: 'a value vs null (right null guard)',
      should: 'return false',
      actual: deepEqual(5, null),
      expected: false,
    });
  });
});

describe('deepEqual — Date vs Date (by instant)', () => {
  it('treats equal instants as equal', () => {
    assert({
      given: 'two Date objects at the same instant',
      should: 'return true',
      actual: deepEqual(new Date('2024-01-01T00:00:00.000Z'), new Date('2024-01-01T00:00:00.000Z')),
      expected: true,
    });
  });

  it('treats different instants as different', () => {
    assert({
      given: 'two Date objects at different instants',
      should: 'return false',
      actual: deepEqual(new Date('2024-01-01T00:00:00.000Z'), new Date('2024-02-01T00:00:00.000Z')),
      expected: false,
    });
  });
});

describe('deepEqual — Date vs ISO string (chosen contract: compare by instant)', () => {
  it('treats a Date and an ISO string of the same instant as equal', () => {
    assert({
      given: 'a Date and an ISO string of the same instant, differing only in serialization',
      should: 'return true (compared by instant, not by string form)',
      actual: deepEqual(new Date('2024-01-01T00:00:00.000Z'), '2024-01-01T00:00:00Z'),
      expected: true,
    });
  });

  it('treats a Date and an ISO string of a different instant as different', () => {
    assert({
      given: 'a Date and an ISO string of a different instant',
      should: 'return false',
      actual: deepEqual(new Date('2024-01-01T00:00:00.000Z'), '2024-06-01T00:00:00.000Z'),
      expected: false,
    });
  });

  it('treats an ISO string (left) and a Date (right) of the same instant as equal', () => {
    assert({
      given: 'an ISO string on the left and a Date on the right, same instant',
      should: 'return true (order-independent)',
      actual: deepEqual('2024-01-01T00:00:00.000Z', new Date('2024-01-01T00:00:00.000Z')),
      expected: true,
    });
  });

  it('treats a Date and an unparseable string as different', () => {
    assert({
      given: 'a valid Date and a non-date string',
      should: 'return false (valid instant vs NaN instant)',
      actual: deepEqual(new Date('2024-01-01T00:00:00.000Z'), 'not-a-date'),
      expected: false,
    });
  });

  it('treats two unparseable instants as equal', () => {
    assert({
      given: 'an invalid Date and an unparseable string (both NaN instants)',
      should: 'return true under the NaN-equals-NaN contract',
      actual: deepEqual(new Date('nonsense'), 'also-nonsense'),
      expected: true,
    });
  });
});

describe('deepEqual — arrays', () => {
  it('treats equal arrays as equal', () => {
    assert({
      given: 'two arrays with equal elements',
      should: 'return true',
      actual: deepEqual([1, 2, 3], [1, 2, 3]),
      expected: true,
    });
  });

  it('treats arrays of different length as different', () => {
    assert({
      given: 'arrays of different length',
      should: 'return false',
      actual: deepEqual([1, 2], [1, 2, 3]),
      expected: false,
    });
  });

  it('treats arrays with a differing element as different', () => {
    assert({
      given: 'same-length arrays differing in one element',
      should: 'return false',
      actual: deepEqual([1, 2, 3], [1, 9, 3]),
      expected: false,
    });
  });

  it('treats an array and a non-array as different', () => {
    assert({
      given: 'an array and a plain object',
      should: 'return false',
      actual: deepEqual([1], { 0: 1 }),
      expected: false,
    });
  });
});

describe('deepEqual — objects', () => {
  it('treats equal objects as equal', () => {
    assert({
      given: 'two objects with equal keys and values',
      should: 'return true',
      actual: deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 }),
      expected: true,
    });
  });

  it('treats objects with different key counts as different', () => {
    assert({
      given: 'objects with different numbers of keys',
      should: 'return false',
      actual: deepEqual({ a: 1 }, { a: 1, b: 2 }),
      expected: false,
    });
  });

  it('treats same-count objects with different keys as different (hasOwnProperty false branch)', () => {
    assert({
      given: 'objects with the same key count but different key names',
      should: 'return false',
      actual: deepEqual({ a: 1 }, { b: 1 }),
      expected: false,
    });
  });

  it('recurses into nested objects', () => {
    assert({
      given: 'nested objects with an equal deep value',
      should: 'return true',
      actual: deepEqual({ a: { b: 2 } }, { a: { b: 2 } }),
      expected: true,
    });
  });

  it('treats an object and a primitive as different', () => {
    assert({
      given: 'an object and a number',
      should: 'return false',
      actual: deepEqual({}, 5),
      expected: false,
    });
  });

  it('locks the undefined-vs-missing-own-key decision', () => {
    assert({
      given: 'an object with an explicit undefined field vs an object missing that key',
      should: 'return false — key presence is significant',
      actual: deepEqual({ x: undefined }, {}),
      expected: false,
    });
  });
});
