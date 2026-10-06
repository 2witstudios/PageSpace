import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { cn } from './cn';

describe('cn()', () => {
  test('joins class fragments', () => {
    assert({
      given: 'class fragments mixed with false, null, undefined and empty strings',
      should: 'join only the truthy fragments with single spaces, in order',
      actual: cn('a', false, null, 'b', undefined, '', 'c'),
      expected: 'a b c',
    });
  });

  test('no fragments', () => {
    assert({
      given: 'no truthy fragments',
      should: 'return an empty class list',
      actual: cn(undefined, false),
      expected: '',
    });
  });
});
