/**
 * Every routed verb must appear in the published README.
 *
 * `README.md` carries a hand-maintained command list, and nothing tied it to
 * `ROUTES` — so six `sheets` verbs shipped routed, built, and documented
 * everywhere except the file a user actually reads. This is the cheapest guard
 * that would have caught it: a substring check per verb, not a parser, so it
 * stays honest without becoming brittle about formatting.
 *
 * It deliberately checks the LAST path segment. A resource group heading
 * (`sheets`) plus one line per verb is the README's existing shape, and the
 * verb is the part that goes missing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../routes.js';

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../README.md'), 'utf-8');

describe('README command coverage', () => {
  it('documents every routed verb', () => {
    const undocumented = ROUTES.map((route) => route.path)
      .filter((path) => {
        const verb = path[path.length - 1];
        return verb !== undefined && !new RegExp(`\\b${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(readme);
      })
      .map((path) => path.join(' '));

    expect(
      undocumented,
      `routed verbs missing from packages/cli/README.md:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });
});
