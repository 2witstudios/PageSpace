import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guideline 2.3.10: the iOS app must not name other mobile platforms.
describe('open-source licenses page', () => {
  it('given the page renders in the iOS app, should not mention Android', () => {
    const source = readFileSync(join(__dirname, '../page.tsx'), 'utf8');
    expect(source).not.toMatch(/\bAndroid\b/);
  });
});
