/**
 * App Review reads the legal pages the app links to. Read as text from the
 * marketing app, which has no test runner of its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETING = resolve(HERE, '../../../../marketing/src/app');
const read = (page: string) => readFileSync(resolve(MARKETING, page, 'page.tsx'), 'utf-8');

describe('legal pages for App Review', () => {
  const terms = read('terms');
  const privacy = read('privacy');

  // Guideline 1.2: apps with user-generated content need terms that make clear
  // there is no tolerance for objectionable content or abusive users.
  it('given a user reads the Terms, should find zero tolerance for objectionable content and abusive users', () => {
    expect(terms).toMatch(/zero tolerance/i);
    expect(terms).toMatch(/objectionable content/i);
    expect(terms).toMatch(/abusive/i);
  });

  it('given the signup screens require users to be at least 16, should state the same minimum age in the Terms', () => {
    expect(terms).toMatch(/at least 16/i);
  });

  it('given the signup screens require users to be at least 16, should state the same minimum age in the privacy policy', () => {
    expect(privacy).toMatch(/under 16/i);
    expect(privacy).not.toMatch(/under 13/i);
  });

  it('given Sentry Session Replay runs on the web, should disclose it on the subprocessors page', () => {
    expect(read('subprocessors')).toMatch(/session replay/i);
  });
});
