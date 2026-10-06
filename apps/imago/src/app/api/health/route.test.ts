import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { GET } from './route';

describe('GET /imago/api/health', () => {
  test('liveness probe', async () => {
    const response = GET();

    assert({
      given: 'a health check request',
      should: 'respond 200',
      actual: response.status,
      expected: 200,
    });

    assert({
      given: 'a health check request',
      should: "report { status: 'ok' }",
      actual: await response.json(),
      expected: { status: 'ok' },
    });

    assert({
      given: 'a health check request',
      should: 'never be cached',
      actual: response.headers.get('Cache-Control'),
      expected: 'no-store',
    });
  });
});
