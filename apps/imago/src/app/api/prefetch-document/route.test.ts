import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { GET } from './route';

describe('GET /imago/api/prefetch-document', () => {
  test('a prefetch-headed document request', async () => {
    const response = GET();

    assert({
      given: 'a document request carrying next-router-prefetch (rewritten here)',
      should: 'answer 404',
      actual: response.status,
      expected: 404,
    });

    assert({
      given: 'a document request carrying next-router-prefetch',
      should: 'answer with no body',
      actual: await response.text(),
      expected: '',
    });

    assert({
      given: 'a document request carrying next-router-prefetch',
      should: 'never be cached',
      actual: response.headers.get('Cache-Control'),
      expected: 'no-store',
    });
  });
});
