import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { withAccountType } from './account-type';

describe('withAccountType()', () => {
  test('an account type', () => {
    assert({
      given: 'an account type from the server',
      should: 'carry it under the key',
      actual: withAccountType('authorAccountType', 'agent'),
      expected: { authorAccountType: 'agent' },
    });
  });

  test('no account type', () => {
    assert({
      given: 'no account type (absent, null or empty)',
      should: 'add nothing, so the row keeps its shape',
      actual: [withAccountType('accountType', undefined), withAccountType('accountType', null), withAccountType('accountType', '')],
      expected: [{}, {}, {}],
    });
  });
});
