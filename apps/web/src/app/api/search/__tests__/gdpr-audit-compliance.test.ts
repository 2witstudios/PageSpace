/**
 * GDPR Compliance: Verify audit log details do not contain PII.
 *
 * The `details` field in audit events is included in the tamper-evident
 * hash chain and cannot be erased under GDPR Article 17.
 *
 * This test statically verifies that search route audit calls do not pass
 * user-typed query text in the `details` object.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

function readRoute(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf-8');
}

/**
 * Extract the details object literal from an auditRequest call.
 * Matches: auditRequest(req, { ..., details: { ... } })
 */
function extractAuditDetailsBlocks(source: string): string[] {
  const blocks: string[] = [];
  // Match details: { ... } inside auditRequest calls
  const pattern = /auditRequest\([^;]*details:\s*\{([^}]+)\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe('GDPR: audit details must not contain user-typed text or PII', () => {
  it('search/route.ts should not include query in audit details', () => {
    const source = readRoute('search/route.ts');
    const blocks = extractAuditDetailsBlocks(source);
    // search route may not have details - just verify no query if present
    for (const block of blocks) {
      expect(block).not.toMatch(/\bquery\b/);
    }
  });

  it('search/multi-drive/route.ts should not include query in audit details', () => {
    const source = readRoute('search/multi-drive/route.ts');
    const blocks = extractAuditDetailsBlocks(source);
    for (const block of blocks) {
      expect(block).not.toMatch(/\bquery\b/);
    }
  });

  it('mentions/search/route.ts should not include query in audit details', () => {
    const source = readRoute('mentions/search/route.ts');
    const blocks = extractAuditDetailsBlocks(source);
    for (const block of blocks) {
      expect(block).not.toMatch(/\bquery\b/);
    }
  });

  it('admin/audit-logs/route.ts should not include userId filter in audit details', () => {
    const source = readRoute('admin/audit-logs/route.ts');
    const blocks = extractAuditDetailsBlocks(source);
    for (const block of blocks) {
      // Should not contain raw filter objects with userId
      expect(block).not.toMatch(/filters.*userId/);
    }
  });
});
