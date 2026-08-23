/**
 * Issue #2470's complaint was not the refusal — correct for a view-only grant —
 * but that it named nowhere to look, so a grant could only be learned one failed
 * write at a time.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { writeDeniedDetails } from '../write-denied-details';

describe('writeDeniedDetails', () => {
  it('keeps the operation name, which the route security suites pin', () => {
    expect(writeDeniedDetails('replace', 'document')).toContain("'replace'");
  });

  it('names the subject it was called for', () => {
    expect(writeDeniedDetails('replace', 'document')).toContain('this document');
    expect(writeDeniedDetails('append-rows', 'sheet')).toContain('this sheet');
  });

  // Both halves are facts about THIS request: the caller cleared the view gate
  // immediately before reaching the write gate, so "can view, cannot edit" is
  // established rather than guessed.
  it('states what the credential CAN do here, not only what it cannot', () => {
    expect(writeDeniedDetails('replace', 'document')).toMatch(/can view this page but not edit it/i);
  });

  it('points at the self-description on both surfaces an agent might be driving', () => {
    const details = writeDeniedDetails('replace', 'document');
    expect(details).toContain('tokens.describeSelf');
    expect(details).toContain('pagespace keys describe --page');
  });

  // The module is imported by two routes whose suites partially mock
  // `@/lib/auth`; a barrel import here would make a missing mock surface as an
  // opaque 500 instead of the 403 under test.
  // `mcp/documents` has a security suite that exercises its 403 end to end;
  // `mcp/sheets` has no test file at all, so its wiring is pinned statically
  // rather than left to a future edit to quietly hand-roll the string back.
  // Same idiom as the repo's other coverage gates (readme-coverage,
  // security-audit-coverage), which read route sources as text.
  it.each([
    ['documents', 'document'],
    ['sheets', 'sheet'],
  ])('the %s route builds its details through this helper, not by hand', (route, subject) => {
    const source = readFileSync(join(__dirname, '..', route, 'route.ts'), 'utf-8');
    expect(source).toContain(`writeDeniedDetails(operation, '${subject}')`);
    // The stable half of the contract: `error` must stay the string the
    // security suites and clients branch on.
    expect(source).toContain("error: 'Write permission required'");
    // No hand-rolled variant left behind beside the shared one.
    expect(source).not.toMatch(/details: `The '\$\{operation\}' operation requires edit access/);
  });

  it('is a leaf — it imports nothing', () => {
    const source = readFileSync(join(__dirname, '..', 'write-denied-details.ts'), 'utf-8');
    expect(source).toContain('export function writeDeniedDetails');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
