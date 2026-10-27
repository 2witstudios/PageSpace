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
import {
  buildSearchAuditDetails,
  auditDetailsContainText,
} from '@pagespace/lib/audit/search-audit-details';

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

});

/**
 * Runtime enforcement (GDPR #971): the static source scan above is a regression
 * guard only. The audit details actually emitted by every search route are now
 * built by buildSearchAuditDetails, which structurally cannot include the query.
 */
describe('GDPR: search audit details exclude the user query at runtime', () => {
  const QUERY = "alice's confidential salary 2026";

  it('builder ignores a query smuggled in via an untyped field', () => {
    const details = buildSearchAuditDetails({ resultCount: 5, query: QUERY } as unknown as {
      resultCount: number;
    });
    expect(auditDetailsContainText(details, QUERY)).toBe(false);
    expect(JSON.stringify(details)).not.toContain('alice');
  });

  it('every whitelisted shape used by the routes is query-free', () => {
    const shapes = [
      buildSearchAuditDetails({ resultCount: 3 }),
      buildSearchAuditDetails({ resultCount: 3, source: 'multi-drive', searchType: 'text' }),
      buildSearchAuditDetails({ resultCount: 3, source: 'mentions' }),
    ];
    for (const details of shapes) {
      expect(auditDetailsContainText(details, QUERY)).toBe(false);
    }
  });
});
