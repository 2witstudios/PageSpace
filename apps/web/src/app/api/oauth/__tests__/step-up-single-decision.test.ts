/**
 * Step-up has ONE decision point (ADR 0004 Decision 6, Phase 1 obligation 2).
 *
 * `requiresStepUp(scopes)` (`@pagespace/lib/auth/oauth/step-up-boundary`) is
 * the only expression of "does approving this grant need a second factor".
 * The screen that decides whether to RUN the ceremony and the server that
 * decides whether to REQUIRE one must read the same answer — two expressions
 * of the rule is how a future scope lands on a screen that never runs the
 * ceremony, or on a server that stops demanding one.
 *
 * Structural, so it cannot be satisfied by review alone. Enumeration is
 * dynamic: a new consent surface is covered without editing this file.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const WEB_SRC = join(__dirname, '..', '..', '..', '..');

/** The OAuth consent surfaces: the provider routes and the consent screen. */
const CONSENT_SURFACE_DIRS = [join(WEB_SRC, 'app', 'api', 'oauth'), join(WEB_SRC, 'app', 'oauth')];

/** Performing or requesting a step-up on a consent surface. */
const STEP_UP_EFFECT = /\b(consumeStepUpGrant|requireStepUpGrant|attemptStepUp)\s*\(/;
/** The single decision, called directly or through the consent screen's parse-then-decide wrapper. */
const STEP_UP_DECISION = /\b(requiresStepUp|consentRequiresStepUp)\s*\(/;

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

/** Comments may NAME the retired predicate (history); only code may not USE it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

const rel = (file: string) => relative(WEB_SRC, file);

describe('step-up single decision point', () => {
  it('finds the consent surfaces it guards (the scan is not vacuous)', () => {
    const guarded = CONSENT_SURFACE_DIRS.flatMap(collectSourceFiles)
      .filter((file) => STEP_UP_EFFECT.test(code(file)))
      .map(rel)
      .sort();

    expect(guarded).toEqual(
      expect.arrayContaining([
        'app/api/oauth/authorize/route.ts',
        'app/api/oauth/device_authorization/decision/route.ts',
        'app/oauth/consent/ConsentActions.tsx',
      ]),
    );
  });

  it('no web source file decides step-up with isCredentialEscalatingGrant', () => {
    const offenders = collectSourceFiles(WEB_SRC)
      .filter((file) => /\bisCredentialEscalatingGrant\b/.test(code(file)))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it('every consent surface that performs a step-up takes the decision from requiresStepUp', () => {
    const offenders = CONSENT_SURFACE_DIRS.flatMap(collectSourceFiles)
      .filter((file) => {
        const source = code(file);
        return STEP_UP_EFFECT.test(source) && !STEP_UP_DECISION.test(source);
      })
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it('the device verify route advertises the ceremony from requiresStepUp', () => {
    const source = code(join(WEB_SRC, 'app', 'api', 'oauth', 'device_authorization', 'verify', 'route.ts'));

    expect(source).toMatch(/\brequiresStepUp\s*\(/);
  });

  it('nothing in apps/web redefines requiresStepUp locally', () => {
    const offenders = collectSourceFiles(WEB_SRC)
      .filter((file) => /\b(function\s+requiresStepUp\b|const\s+requiresStepUp\s*=\s*\()/.test(code(file)))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it('the consent screen wrapper delegates to requiresStepUp rather than re-deriving it', () => {
    const source = code(join(WEB_SRC, 'app', 'oauth', 'consent', 'consent-step-up.ts'));

    expect(source).toMatch(/from ['"]@pagespace\/lib\/auth\/oauth\/step-up-boundary['"]/);
    expect(source).toMatch(/\brequiresStepUp\s*\(/);
  });
});

/**
 * Scope narration has ONE implementation too (ADR 0004 Decision 4, Phase 1
 * obligation 5): three surfaces each re-deriving what a scope means is how
 * `profile` had to be taught to all three separately, and how the next scope
 * gets missed. The live consent surfaces call `describeGrantScopes`; none
 * builds its list from `describeScopeForConsent` directly.
 */
describe('scope narration single implementation', () => {
  const NARRATING_SURFACES = [
    join(WEB_SRC, 'app', 'oauth', 'consent', 'page.tsx'),
    join(WEB_SRC, 'app', 'api', 'oauth', 'device_authorization', 'verify', 'route.ts'),
  ];

  for (const file of NARRATING_SURFACES) {
    it(`${rel(file)} narrates through describeGrantScopes`, () => {
      const source = code(file);

      expect(source).toMatch(/\bdescribeGrantScopes\s*\(/);
      expect(source).not.toMatch(/\bdescribeScopeForConsent\b/);
    });
  }
});
