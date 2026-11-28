import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { defaultWorkerEntry } from '../local-chromium-substrate-adapter.js';

describe('defaultWorkerEntry', () => {
  it('names the compiled worker beside the adapter module', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert({
      given: 'the adapter loaded from source, as a bundler compiles it',
      should: 'give the .js worker in the same directory, which only the dist has',
      actual: defaultWorkerEntry(),
      expected: join(src, 'standalone-browser-worker.js'),
    });
  });
});
