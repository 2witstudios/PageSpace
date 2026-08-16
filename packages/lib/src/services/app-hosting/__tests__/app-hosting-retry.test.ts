import { describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLAPS_MAX_RETRY_DELAY_MS,
  flapsRetryDelayMs,
  parseRetryAfterMs,
  planFlapsRetry,
} from '../app-hosting-retry';
import { assert } from './riteway';

describe('flapsRetryDelayMs', () => {
  assert({
    given: 'the first three attempts',
    should: 'back off linearly at Fly\'s ~1 r/s per-object rate',
    actual: [1, 2, 3].map((n) => flapsRetryDelayMs(n)),
    expected: [1000, 2000, 3000],
  });

  assert({
    given: 'an absurd attempt number',
    should: 'clamp to the maximum rather than sleeping for hours',
    actual: flapsRetryDelayMs(10_000),
    expected: FLAPS_MAX_RETRY_DELAY_MS,
  });
});

describe('parseRetryAfterMs', () => {
  assert({
    given: 'a delta-seconds header',
    should: 'convert it to milliseconds',
    actual: parseRetryAfterMs('2'),
    expected: 2000,
  });

  assert({
    given: 'no header',
    should: 'return null, meaning "use the backoff schedule"',
    actual: parseRetryAfterMs(null),
    expected: null,
  });

  assert({
    given: 'an HTTP-date header (which Fly does not send)',
    should: 'return null rather than guessing against a clock this pure module cannot have',
    actual: parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'),
    expected: null,
  });

  assert({
    given: 'a negative value',
    should: 'return null rather than a negative sleep',
    actual: parseRetryAfterMs('-5'),
    expected: null,
  });

  assert({
    given: 'an enormous Retry-After',
    should: 'clamp to the maximum',
    actual: parseRetryAfterMs('99999'),
    expected: FLAPS_MAX_RETRY_DELAY_MS,
  });
});

describe('planFlapsRetry', () => {
  assert({
    given: 'a 429 on the first attempt',
    should: 'retry — this is the expected rate-limit response',
    actual: planFlapsRetry({ status: 429, attempt: 1 }),
    expected: { retry: true, delayMs: 1000 },
  });

  assert({
    given: 'a 429 with a Retry-After',
    should: 'honour the server delay over our schedule',
    actual: planFlapsRetry({ status: 429, retryAfterMs: 5000, attempt: 1 }),
    expected: { retry: true, delayMs: 5000 },
  });

  assert({
    given: 'a 503',
    should: 'retry — a Fly-side transient says nothing about our request',
    actual: planFlapsRetry({ status: 503, attempt: 1 }),
    expected: { retry: true, delayMs: 1000 },
  });

  assert({
    given: 'a transport failure that never reached Fly',
    should: 'retry like a 5xx',
    actual: planFlapsRetry({ status: null, attempt: 1 }),
    expected: { retry: true, delayMs: 1000 },
  });

  assert({
    given: 'a 403',
    should: 'NOT retry — an auth failure is equally true next second',
    actual: planFlapsRetry({ status: 403, attempt: 1 }),
    expected: { retry: false },
  });

  assert({
    given: 'a 404',
    should: 'NOT retry',
    actual: planFlapsRetry({ status: 404, attempt: 1 }),
    expected: { retry: false },
  });

  assert({
    given: 'a 422',
    should: 'NOT retry — a rejected request body does not become valid on repetition',
    actual: planFlapsRetry({ status: 422, attempt: 1 }),
    expected: { retry: false },
  });

  assert({
    given: 'the final attempt',
    should: 'stop, however retryable the status',
    actual: planFlapsRetry({ status: 429, attempt: 3 }),
    expected: { retry: false },
  });
});

describe('purity', () => {
  const source = readFileSync(join(__dirname, '..', 'app-hosting-retry.ts'), 'utf8');
  const runtimeImports = source
    .split('\n')
    .filter((line) => /^import /.test(line) && !/^import type /.test(line));

  assert({
    given: 'the retry decision layer',
    should: 'have no runtime imports',
    actual: runtimeImports,
    expected: [],
  });

  assert({
    given: 'the retry decision layer',
    should: 'never sleep or touch a timer itself — it only returns delays',
    actual: /setTimeout|setInterval|await /.test(source),
    expected: false,
  });
});
