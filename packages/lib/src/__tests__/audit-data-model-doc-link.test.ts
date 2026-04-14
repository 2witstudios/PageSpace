/**
 * Link-check guard for the three-table audit data model doc.
 *
 * Regression guard: if `docs/security/audit-data-model.md` is moved or
 * CLAUDE.md drops its reference, CI fails here. The doc is the canonical
 * explanation of when to use `security_audit_log` vs `activity_logs` vs
 * `system_logs`, so its discoverability matters. Placed in packages/lib
 * so it runs in the standard @pagespace/lib vitest project.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOC_REL_PATH = 'docs/security/audit-data-model.md';
const DOC_ABS_PATH = path.resolve(REPO_ROOT, DOC_REL_PATH);
const CLAUDE_MD_PATH = path.resolve(REPO_ROOT, 'CLAUDE.md');

describe('Three-Table Audit Model doc', () => {
  it('exists at docs/security/audit-data-model.md', () => {
    expect(existsSync(DOC_ABS_PATH)).toBe(true);
  });

  it('is referenced from CLAUDE.md key source locations', async () => {
    const claudeMd = await readFile(CLAUDE_MD_PATH, 'utf-8');
    expect(claudeMd).toContain(DOC_REL_PATH);
  });
});
