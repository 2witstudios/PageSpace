/**
 * ADR 0007 §4 — the reserved agent domain is sealed at exactly nine inbound
 * sites (the ADR's five, plus the four invite/admin sign-in sites Agent Signup
 * Phase 1b sealed) and one outbound choke point. The domain's safety is a convention
 * enforced in code (threat model §4.5), so this test enumerates the sites and
 * fails when one of them stops applying the shared predicate. Pattern of
 * `apps/web/src/app/api/__tests__/security-audit-coverage.test.ts`: read the
 * source, never trust a comment.
 *
 * Each site's BEHAVIOUR (a reserved address gets the site's ordinary
 * validation error) is pinned beside the site in its own test file; this file
 * is the inventory that keeps a later refactor from silently dropping one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../../../../..');

/** The inbound sites: ADR 0007 §4's five (numbered as there), then Phase 1b's four. */
const INBOUND_SITES = [
  'apps/web/src/app/api/auth/magic-link/send/route.ts',
  'apps/web/src/app/api/auth/signup-passkey/options/route.ts',
  'packages/lib/src/auth/oauth-account-match.ts',
  'apps/admin/src/app/api/admin/users/create/route.ts',
  'apps/web/src/app/api/account/route.ts',
  'apps/web/src/app/api/drives/[driveId]/members/invite/route.ts',
  'apps/web/src/app/api/pages/[pageId]/share-invite/route.ts',
  'apps/web/src/app/api/connections/invite/route.ts',
  'apps/admin/src/app/api/auth/magic-link/send/route.ts',
] as const;

const OUTBOUND_SITE = 'packages/lib/src/services/email-service.ts';

/** Source with line and block comments removed, so prose never satisfies an assertion. */
function code(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const IMPORTS_RESERVED_EMAIL = /import\s*\{[^}]*\bnotAgentReservedEmail\b[^}]*\}\s*from\s*'[^']*\bagent\/reserved-email'/;

describe('reserved agent domain — inbound sites', () => {
  it('given the inventory, should name exactly nine sites', () => {
    expect(new Set(INBOUND_SITES).size).toBe(9);
  });

  it.each(INBOUND_SITES)('given %s, should import notAgentReservedEmail from the shared module and apply it', (site) => {
    const source = code(site);
    expect(source, `${site} must import notAgentReservedEmail`).toMatch(IMPORTS_RESERVED_EMAIL);
    const uses = source.match(/\bnotAgentReservedEmail\b/g) ?? [];
    expect(uses.length, `${site} imports notAgentReservedEmail but never applies it`).toBeGreaterThanOrEqual(2);
  });
});

describe('reserved agent domain — outbound choke point', () => {
  it('given sendEmail, should short-circuit on isAgentReservedEmail', () => {
    const source = code(OUTBOUND_SITE);
    expect(source).toMatch(/import\s*\{[^}]*\bisAgentReservedEmail\b[^}]*\}\s*from\s*'[^']*auth\/agent\/reserved-email'/);
    expect(source).toMatch(/if\s*\(\s*isAgentReservedEmail\(\s*options\.to\s*\)\s*\)/);
  });
});
