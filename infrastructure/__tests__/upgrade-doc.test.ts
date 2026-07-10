import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const UPGRADE_PATH = resolve(__dirname, '../UPGRADE.md');
const TEMPLATE_PATH = resolve(__dirname, '../env.tenant.template');

/**
 * infrastructure/UPGRADE.md is the operator-facing upgrade note for existing
 * tenant/self-host deployments. The tenant compose's required-var errors
 * (${ADMIN_POSTGRES_PASSWORD:?...}) point operators here, so the doc MUST
 * exist and MUST carry the exact remediation: append the ADMIN_POSTGRES_*
 * vars to the EXISTING .env — never regenerate it.
 */
describe('infrastructure/UPGRADE.md (operator upgrade note)', () => {
  it('given the infrastructure directory, should contain UPGRADE.md', () => {
    expect(existsSync(UPGRADE_PATH)).toBe(true);
  });

  const doc = existsSync(UPGRADE_PATH) ? readFileSync(UPGRADE_PATH, 'utf-8') : '';

  it('given the Phase 1 section, should be dated', () => {
    expect(doc).toMatch(/## .*2026-07/);
  });

  it('given the Phase 1 section, should show the exact ADMIN_POSTGRES_* lines to append', () => {
    expect(doc).toContain('ADMIN_POSTGRES_DB=pagespace_admin');
    expect(doc).toContain('ADMIN_POSTGRES_USER=pagespace');
    expect(doc).toMatch(/ADMIN_POSTGRES_PASSWORD=/);
  });

  it('given the ADMIN_POSTGRES_DB/USER lines, should mirror env.tenant.template exactly', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf-8');
    for (const key of ['ADMIN_POSTGRES_DB', 'ADMIN_POSTGRES_USER'] as const) {
      const templateLine = template.split('\n').find((l) => l.startsWith(`${key}=`));
      expect(templateLine).toBeDefined();
      expect(doc).toContain(templateLine as string);
    }
  });

  it('given the remediation steps, should warn NEVER to re-run generate-tenant-env.sh on a live deployment', () => {
    expect(doc).toContain('generate-tenant-env.sh');
    expect(doc).toMatch(/never/i);
    // The reason must be spelled out: regenerating rotates ALL secrets
    // including ENCRYPTION_KEY, which makes existing encrypted data unreadable.
    expect(doc).toContain('ENCRYPTION_KEY');
  });

  it('given the remediation steps, should instruct appending to the EXISTING .env', () => {
    expect(doc).toMatch(/append/i);
    expect(doc).toMatch(/existing/i);
  });
});
