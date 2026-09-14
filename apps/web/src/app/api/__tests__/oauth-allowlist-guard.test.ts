/**
 * OAuth ⇒ mcp parity guard (Sign in with PageSpace, Phase 2 — epic
 * Architecture decision 10, ADR 0002 Decision 2).
 *
 * An OAuth drive grant resolves exactly like a drive-scoped `mcp_` key with the
 * same role. Two ways that contract silently breaks, one test each:
 *
 *  (a) DRIFT — a route admits `mcp` but not `oauth`, so a third-party app signed
 *      in by the user gets 401 where the equivalent key works. Every `allow:`
 *      array (and every `authenticateMCPRequest(` door) that admits `mcp` must
 *      also admit `oauth`, unless the route is on {@link OAUTH_ALLOWLIST_DENY}.
 *
 *  (b) THE HOLE — a route admits `oauth` but still decides scope with an
 *      MCP-only predicate. `isScopedMCPAuth` is a type guard true ONLY for
 *      `tokenType === 'mcp'`, so a drive-scoped (or profile-only) OAuth token
 *      falls into its else branch — which in these routes is the owning user's
 *      FULL access in every drive. A route that admits `oauth` must decide
 *      through the principal-neutral helpers (`isDriveScopedPrincipal`,
 *      `getAllowedDriveIds`, `check*Scope`, `*Principal*`) instead.
 *
 * The scan parses `allow: [...]` array literals — it never greps for the word
 * `mcp` (`oauth/token/route.ts` mentions it while serialising key grants and has
 * no allow list at all).
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const API_DIR = join(__dirname, '..');

/**
 * Routes that admit `mcp` but must NOT be required to admit `oauth`.
 * Matched against the route directory relative to `app/api` (exact, or a
 * `prefix/*` wildcard for the whole subtree). `forbidOAuth` additionally
 * asserts the route does not admit `oauth` at all — set on every surface a
 * third-party app must never reach; left false only where the route already
 * admits first-party OAuth credentials under its own gate.
 */
export const OAUTH_ALLOWLIST_DENY: ReadonlyArray<{
  readonly route: string;
  readonly forbidOAuth: boolean;
  readonly reason: string;
}> = [
  { route: 'env-bridge/*', forbidOAuth: true, reason: "A machine's own credential surface — never a third-party app." },
  { route: 'connections', forbidOAuth: true, reason: "The user's third-party integration credentials (Google, GitHub…); an app must not read or manage them." },
  { route: 'auth/mcp-tokens/*', forbidOAuth: false, reason: 'Key management — governed by manage_keys and first-party only, already gated in the route.' },
  { route: 'auth/mcp-tokens', forbidOAuth: false, reason: 'Key management — governed by manage_keys and first-party only, already gated in the route.' },
  { route: 'auth/key', forbidOAuth: false, reason: 'Key self-introspection/management — governed by manage_keys and first-party only.' },
  { route: 'account/*', forbidOAuth: true, reason: 'Account settings, deletion and connected-app management are the account holder’s, never an app’s.' },
  { route: 'stripe/*', forbidOAuth: true, reason: 'Billing.' },
  { route: 'billing/*', forbidOAuth: true, reason: 'Billing.' },
  { route: 'auth/step-up/*', forbidOAuth: true, reason: 'Step-up ceremonies prove the human is present; an app token can never satisfy one.' },
  { route: 'auth/passkey/*', forbidOAuth: true, reason: 'Step-up / credential ceremonies.' },
  { route: 'oauth/*', forbidOAuth: true, reason: 'The authorization server itself, including the consent POST.' },
];

/**
 * TEMPORARY exclusion — Phase 2b's first act is to empty this list.
 *
 * Routes that EXECUTE AGENT TOOLS under a `ToolExecutionContext`. Their `oauth`
 * widening is held (point-guard ruling, 2026-09-14) because widening them now
 * would let an OAuth token exceed a same-role `mcp_` key: the tool layer's
 * per-drive role ceiling keys only on `mcpTokenId`. Not a deny — the intent is
 * to widen these once Phase 2b generalizes that ceiling. Handoff notes live on
 * the Phase 2 page (ykd6o6kam220qrw2zgysxdzc) under "Handoff to Phase 2b".
 */
const TOOL_CEILING_REASON =
  "Executes agent tools; the per-drive ROLE ceiling in lib/ai/tools/actor-permissions.ts (hasAppTokenCeiling / driveDeniedByAppToken / getActorAccessiblePagesInDrive) keys only on context.mcpTokenId, so an OAuth drive:X:member token would run tools with the owning user's full role in X.";

export const PENDING_PHASE_2B: ReadonlyArray<{ readonly route: string; readonly file: string; readonly reason: string }> = [
  { route: 'ai/page-agents/consult', file: 'apps/web/src/app/api/ai/page-agents/consult/route.ts', reason: TOOL_CEILING_REASON },
  { route: 'v1/chat/completions', file: 'apps/web/src/app/api/v1/chat/completions/route.ts', reason: TOOL_CEILING_REASON },
];

/**
 * MCP-only decisions a route admitting `oauth` must not make. Each pattern is a
 * shape that is true, or reads a field that only exists, for `tokenType: 'mcp'`.
 * `isMCPAuthResult(auth)` used purely to tag audit metadata (`source: 'mcp'`)
 * is deliberately not flagged: it decides nothing about access.
 */
const MCP_ONLY_DECISION_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'isScopedMCPAuth(', pattern: /\bisScopedMCPAuth\(/ },
  { name: "tokenType === 'mcp'", pattern: /\btokenType\s*[!=]==?\s*['"]mcp['"]/ },
  { name: 'auth.tokenId', pattern: /\b(?:auth|authResult)\.tokenId\b/ },
  { name: 'isMCPAuthResult(…) guarding a scope field', pattern: /\bisMCPAuthResult\(\s*\w+\s*\)\s*(?:&&|\?)[^;\n]*\.(?:allowedDriveIds|tokenId)\b/ },
  { name: 'if (isMCPAuthResult(…)) { …scope field… }', pattern: /\bif\s*\(\s*isMCPAuthResult\(\s*\w+\s*\)\s*\)\s*\{[^}]*\.(?:allowedDriveIds|tokenId)\b/ },
];

/**
 * Files admitting `oauth` where an MCP-only read is correct by construction,
 * each with the reason the read decides nothing about content access.
 */
export const MCP_ONLY_DECISION_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'auth/key',
    "Reports the presented credential itself: for an mcp_ key it looks up that key's own row by tokenId; every other type returns the base shape. No content access is decided.",
  ],
]);

/**
 * Routes admitting `oauth` WITHOUT `mcp`. The door treats a route that admits
 * `mcp` as a content route and refuses no-content OAuth credentials (`profile`,
 * `manage_keys`) there; a route admitting `oauth` alone still serves them. So
 * that shape is pinned: a content route written as `['session', 'oauth']` would
 * hand a profile-only token whatever its identity-bound decisions release.
 */
export const OAUTH_WITHOUT_MCP_ROUTES: ReadonlyMap<string, string> = new Map([
  ['auth/me', 'Identity itself — a profile token must resolve here (ADR 0004 Decision 4); disclosure is decided per token in the route.'],
  ['auth/mcp-tokens', "Lists the user's keys for the first-party manage_keys credential; gated on manage_keys in the route."],
  ['auth/mcp-tokens/[tokenId]', "Revokes a key for the first-party manage_keys credential; gated on manage_keys in the route."],
]);

/**
 * Content-admitting routes that opt back in to no-content OAuth credentials
 * (`admitNoContentOAuth: true`), each with why that credential must reach it.
 */
export const ADMIT_NO_CONTENT_OAUTH_ROUTES: ReadonlyMap<string, string> = new Map([
  ['drives', 'The `pagespace keys` wizard lists the drives a new key may be scoped to with its manage_keys credential; a profile-only token lists nothing (no drive rows).'],
  ['auth/key', 'Reports the presented credential itself — what it is and what it may reach — whatever that credential is.'],
]);

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findRouteFiles(full));
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

function routeKey(file: string): string {
  return relative(API_DIR, file).split(sep).slice(0, -1).join('/');
}

function matchesRoute(key: string, route: string): boolean {
  if (route.endsWith('/*')) {
    const prefix = route.slice(0, -2);
    return key === prefix || key.startsWith(`${prefix}/`);
  }
  return key === route;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every token-type list a route file admits, one entry per `allow:` array or MCP-only door. */
export function parseAllowLists(source: string): string[][] {
  const code = stripComments(source);
  const lists: string[][] = [];
  for (const match of code.matchAll(/\ballow\s*:\s*\[([^\]]*)\]/g)) {
    lists.push([...match[1].matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]));
  }
  // `authenticateMCPRequest(req)` is an allow list of exactly `['mcp']` written as a call.
  const doors = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
  for (let i = doors(/\bauthenticateMCPRequest\(/g); i > 0; i--) lists.push(['mcp']);
  for (let i = doors(/\bauthenticateHybridRequest\(/g); i > 0; i--) lists.push(['mcp', 'session']);
  return lists;
}

const routes = findRouteFiles(API_DIR).map((file) => {
  const source = readFileSync(file, 'utf8');
  return { key: routeKey(file), source, lists: parseAllowLists(source) };
});

const isDenied = (key: string) => OAUTH_ALLOWLIST_DENY.some((d) => matchesRoute(key, d.route));
const isPendingPhase2b = (key: string) => PENDING_PHASE_2B.some((p) => matchesRoute(key, p.route));

describe('oauth allow-list guard', () => {
  it('parses allow arrays, not the word mcp', () => {
    expect(parseAllowLists("const A = { allow: ['session', 'mcp'] as const };")).toEqual([['session', 'mcp']]);
    expect(parseAllowLists("return { tokenType: 'mcp', allowedDriveIds: [] };")).toEqual([]);
    expect(parseAllowLists('const auth = await authenticateMCPRequest(req);')).toEqual([['mcp']]);
    expect(parseAllowLists("// allow: ['mcp']\nconst A = { allow: ['session'] };")).toEqual([['session']]);
    expect(routes.length).toBeGreaterThan(100);
  });

  it('(a) every allow list admitting mcp also admits oauth, outside the deny list and the TEMPORARY PENDING_PHASE_2B exclusion', () => {
    const offenders = routes
      .filter((r) => !isDenied(r.key) && !isPendingPhase2b(r.key))
      .filter((r) => r.lists.some((list) => list.includes('mcp') && !list.includes('oauth')))
      .map((r) => r.key)
      .sort();

    expect(
      offenders,
      `${offenders.length} route(s) admit 'mcp' without 'oauth'. Add 'oauth' (after making every scope decision in the route principal-neutral), or add the route to OAUTH_ALLOWLIST_DENY with a reason.`,
    ).toEqual([]);
  });

  it('(a) deny-list surfaces a third-party app must never reach do not admit oauth', () => {
    const offenders = routes
      .filter((r) => OAUTH_ALLOWLIST_DENY.some((d) => d.forbidOAuth && matchesRoute(r.key, d.route)))
      .filter((r) => r.lists.some((list) => list.includes('oauth')))
      .map((r) => r.key);
    expect(offenders).toEqual([]);
  });

  // Swept-to routes count too: every route that admits `mcp` outside the deny
  // list and the Phase 2b exclusion is required by (a) to admit `oauth`, so it
  // must already decide principal-neutrally — the fix lands BEFORE the widening.
  it('(b) no route admitting (or required to admit) oauth decides access with an MCP-only predicate', () => {
    const offenders = routes
      .filter(
        (r) =>
          r.lists.some((list) => list.includes('oauth')) ||
          (!isDenied(r.key) && !isPendingPhase2b(r.key) && r.lists.some((list) => list.includes('mcp'))),
      )
      .filter((r) => !MCP_ONLY_DECISION_EXEMPT.has(r.key))
      .flatMap((r) => {
        const code = stripComments(r.source);
        return MCP_ONLY_DECISION_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(
          ({ name }) => `${r.key}: ${name}`,
        );
      })
      .sort();

    expect(
      offenders,
      'A drive-scoped or profile-only OAuth token is not an MCP result and falls into the else branch of these checks (= full user access). Decide through isDriveScopedPrincipal / getAllowedDriveIds / check*Scope / *Principal* instead.',
    ).toEqual([]);
  });

  it('only pinned identity routes admit oauth without mcp', () => {
    const offenders = routes
      .filter((r) => r.lists.some((list) => list.includes('oauth') && !list.includes('mcp')))
      .map((r) => r.key)
      .filter((key) => !OAUTH_WITHOUT_MCP_ROUTES.has(key))
      .sort();
    expect(
      offenders,
      "A route admitting 'oauth' without 'mcp' lets profile-only and manage_keys-only tokens through the door. Admit 'mcp' too if it serves content, or pin it in OAUTH_WITHOUT_MCP_ROUTES with a reason.",
    ).toEqual([]);
  });

  it('only pinned routes opt back in to no-content OAuth credentials', () => {
    const offenders = routes
      .filter((r) => /\badmitNoContentOAuth\s*:\s*true\b/.test(stripComments(r.source)))
      .map((r) => r.key)
      .filter((key) => !ADMIT_NO_CONTENT_OAUTH_ROUTES.has(key))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('exemption and pending entries all name routes that exist', () => {
    const keys = routes.map((r) => r.key);
    for (const key of MCP_ONLY_DECISION_EXEMPT.keys()) expect(keys).toContain(key);
    for (const key of OAUTH_WITHOUT_MCP_ROUTES.keys()) expect(keys).toContain(key);
    for (const key of ADMIT_NO_CONTENT_OAUTH_ROUTES.keys()) expect(keys).toContain(key);
    for (const { route } of PENDING_PHASE_2B) expect(keys).toContain(route);
  });
});
