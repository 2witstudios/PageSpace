import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { CREDITS } from './spend-strip-model';

describe('CREDITS', () => {
  test('the route', () => {
    assert({ given: 'the credit balance', should: 'be read from the credits route', actual: CREDITS, expected: '/api/credits' });
  });
});
