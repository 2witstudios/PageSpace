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
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

const API_DIR = join(__dirname, '..');
const WEB_SRC = join(API_DIR, '..', '..');
/** Defines the auth door; its own `allow:` literals are defaults and signatures, not a route's policy. */
const AUTH_DOOR_FILE = join(WEB_SRC, 'lib', 'auth', 'index.ts');

/**
 * Routes that admit `mcp` but must NOT be required to admit `oauth`.
 * Matched against the route directory relative to `app/api` (exact, or a
 * `prefix/*` wildcard for the whole subtree). `forbidOAuth` additionally
 * asserts the route does not admit `oauth` at all — set on every surface a
 * third-party app must never reach; left false only where the route already
 * admits first-party OAuth credentials under its own gate.
 */
/**
 * Why an interim entry is denied (point-guard ruling 2026-09-14, pending Jono's
 * [D-14]): third-party OAuth gets CONTENT access only. Each category is one
 * decision, so D-14's answer is a one-line edit per category.
 */
export type D14InterimCategory = 'credential-minting' | 'compute-billing-public-exposure' | 'drive-access-control';

export const OAUTH_ALLOWLIST_DENY: ReadonlyArray<{
  readonly route: string;
  readonly forbidOAuth: boolean;
  readonly reason: string;
  /** Set only on `[D-14 interim]` entries. */
  readonly d14Interim?: D14InterimCategory;
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
  { route: 'internal/*', forbidOAuth: true, reason: 'Service-to-service endpoints authenticated by HMAC/shared secret; a bearer credential never belongs here.' },

  // [D-14 interim] (1) credential minting
  { route: 'drives/[driveId]/envs/[envId]/enrollment-code', forbidOAuth: true, d14Interim: 'credential-minting', reason: '[D-14 interim] credential minting: issues a one-time code a machine enrolls with to obtain its own credential.' },
  { route: 'pages/[pageId]/webhooks/*', forbidOAuth: true, d14Interim: 'credential-minting', reason: '[D-14 interim] credential minting: mints, rotates and wires signing secrets for unattended inbound writes (incl. rotate, triggers).' },

  // [D-14 interim] (2) compute, billing, public exposure
  { route: 'drives/[driveId]/envs/*', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: '[D-14 interim] compute, billing, public exposure: sandbox/app environments, their rebuilds, app actions and dedicated-tier dunning state.' },
  { route: 'drives/[driveId]/published-apps', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: '[D-14 interim] compute, billing, public exposure: apps served publicly from the drive.' },
  { route: 'drives/[driveId]/subdomain', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: "[D-14 interim] compute, billing, public exposure: the drive's public publish subdomain." },
  { route: 'drives/[driveId]/domains/*', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: '[D-14 interim] compute, billing, public exposure: custom domains, verification and certificate refresh.' },
  { route: 'drives/[driveId]/publish-home', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: "[D-14 interim] compute, billing, public exposure: publishes the drive's public home." },
  { route: 'pages/[pageId]/publish', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: '[D-14 interim] compute, billing, public exposure: publishes a page to the public web.' },
  { route: 'agent-workspaces/*', forbidOAuth: true, d14Interim: 'compute-billing-public-exposure', reason: '[D-14 interim] compute, billing, public exposure: agent workspace sandboxes — listing them and executing shell commands in them (arrived from master #2653 admitting mcp; held under the same category rather than widened).' },

  // [D-14 interim] (3) who can access the drive
  { route: 'drives/[driveId]/members', forbidOAuth: true, d14Interim: 'drive-access-control', reason: '[D-14 interim] who can access the drive: drive membership.' },
  { route: 'drives/[driveId]/roles/*', forbidOAuth: true, d14Interim: 'drive-access-control', reason: '[D-14 interim] who can access the drive: drive roles and their permissions.' },
];

/**
 * TEMPORARY exclusion — Phase 2b empties this list.
 *
 * Routes that author or trigger agent runs whose tool context does not yet carry
 * the requesting credential's ceiling. The direct tool-executing routes
 * (consult, v1 chat, page chat) left this list once the tool layer's role
 * ceiling became principal-neutral (`credentialCeiling`). Handoff notes live on
 * the Phase 2 page (ykd6o6kam220qrw2zgysxdzc) under "Handoff to Phase 2b".
 */
const DEFERRED_RUN_REASON =
  "Authors deferred agent runs that lib/workflows/workflow-executor.ts executes as the creating user with a ToolExecutionContext carrying no drive ceiling and no role ceiling for ANY credential.";

export const PENDING_PHASE_2B: ReadonlyArray<{ readonly route: string; readonly file: string; readonly reason: string }> = [
  { route: 'workflows', file: 'apps/web/src/app/api/workflows/route.ts', reason: DEFERRED_RUN_REASON },
  { route: 'workflows/[workflowId]', file: 'apps/web/src/app/api/workflows/[workflowId]/route.ts', reason: DEFERRED_RUN_REASON },
  { route: 'tasks/[taskId]/triggers', file: 'apps/web/src/app/api/tasks/[taskId]/triggers/route.ts', reason: DEFERRED_RUN_REASON },
  { route: 'tasks/[taskId]/triggers/[triggerType]', file: 'apps/web/src/app/api/tasks/[taskId]/triggers/[triggerType]/route.ts', reason: DEFERRED_RUN_REASON },
  { route: 'calendar/events/[eventId]/triggers', file: 'apps/web/src/app/api/calendar/events/[eventId]/triggers/route.ts', reason: DEFERRED_RUN_REASON },
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
  { name: '<principal>.tokenId', pattern: /\b(?:auth|authResult|principal)\.tokenId\b/ },
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
 * Forbid-oauth routes whose only `oauth`-admitting list is INHERITED from a
 * helper module they import for something other than its auth door — each with
 * the door the route actually uses.
 */
export const INHERITED_DOOR_NOT_USED: ReadonlyMap<string, string> = new Map([
  [
    'internal/agent-dispatch',
    "Imports dispatchChatTurn from lib/ai/chat-pipeline/handle-chat-turn.ts, which runs strategy selection AFTER authentication; the helper's PAGE_CHAT_AUTH door is never called here. The route authenticates by HMAC over the raw body (parseSignedAgentDispatch) and builds service auth — no bearer credential is admitted.",
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

function findSourceFiles(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findSourceFiles(full, keep));
    } else if (keep(entry)) {
      out.push(full);
    }
  }
  return out;
}

const findRouteFiles = (dir: string) => findSourceFiles(dir, (name) => name === 'route.ts');

/** The local modules a file imports (relative or `@/`), resolved to files on disk. */
function localImports(file: string, source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]/g)) {
    const spec = match[1];
    const base = spec.startsWith('@/') ? join(WEB_SRC, spec.slice(2)) : resolve(dirname(file), spec);
    const found = [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
    if (found) out.push(found);
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

/**
 * An allow list does not have to be written in the route file: a handler module
 * or shared constant it imports (`commands/command-route-helpers.ts`,
 * `lib/ai/chat-pipeline/handle-chat-turn.ts`) decides too. Each route therefore
 * carries the lists — and the source, for (b) and (c) — of every local module
 * it imports that itself declares an auth door.
 */
const authHelperFiles = new Set<string>();
const routes = findRouteFiles(API_DIR).map((file) => {
  const own = readFileSync(file, 'utf8');
  const helpers = localImports(file, own)
    .filter((helper) => helper !== AUTH_DOOR_FILE)
    .map((helper) => ({ helper, source: readFileSync(helper, 'utf8') }))
    .filter(({ source }) => parseAllowLists(source).length > 0);
  for (const { helper } of helpers) authHelperFiles.add(helper);
  const source = [own, ...helpers.map((h) => h.source)].join('\n');
  return { key: routeKey(file), source, lists: parseAllowLists(source) };
});

/** Every non-test module outside the route files that declares an allow list admitting `mcp`. */
const helperFilesAdmittingMcp = [join(API_DIR), join(WEB_SRC, 'lib'), join(WEB_SRC, 'services')]
  .flatMap((dir) => findSourceFiles(dir, (name) => /\.tsx?$/.test(name) && name !== 'route.ts' && !/\.test\.tsx?$/.test(name)))
  .filter((file) => file !== AUTH_DOOR_FILE)
  .filter((file) => parseAllowLists(readFileSync(file, 'utf8')).some((list) => list.includes('mcp')));

const isDenied = (key: string) => OAUTH_ALLOWLIST_DENY.some((d) => matchesRoute(key, d.route));
const isPendingPhase2b = (key: string) => PENDING_PHASE_2B.some((p) => matchesRoute(key, p.route));

describe('oauth allow-list guard', () => {
  it('reaches every allow list written outside a route file through the routes that import it', () => {
    const unreached = helperFilesAdmittingMcp.filter((file) => !authHelperFiles.has(file)).map((file) => relative(WEB_SRC, file));
    expect(unreached, 'An allow list admitting mcp lives in a module no route imports directly — extend localImports or move the list.').toEqual([]);
    expect(helperFilesAdmittingMcp.length).toBeGreaterThan(0);
  });

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
      .filter((r) => !INHERITED_DOOR_NOT_USED.has(r.key))
      .filter((r) => r.lists.some((list) => list.includes('oauth')))
      .map((r) => r.key);
    expect(offenders).toEqual([]);
  });

  // Swept-to routes count too: every route that admits `mcp` outside the deny
  // list and the Phase 2b exclusion is required by (a) to admit `oauth`, so it
  // must already decide principal-neutrally — the fix lands BEFORE the widening.
  it('[D-14 interim] denies are listed by category — one line per category to change when D-14 is answered', () => {
    const byCategory: Record<string, string[]> = {};
    for (const entry of OAUTH_ALLOWLIST_DENY) {
      if (!entry.d14Interim) continue;
      expect(entry.reason.startsWith('[D-14 interim] ')).toBe(true);
      expect(entry.forbidOAuth).toBe(true);
      (byCategory[entry.d14Interim] ??= []).push(entry.route);
    }
    expect(byCategory).toEqual({
      'credential-minting': ['drives/[driveId]/envs/[envId]/enrollment-code', 'pages/[pageId]/webhooks/*'],
      'compute-billing-public-exposure': [
        'drives/[driveId]/envs/*',
        'drives/[driveId]/published-apps',
        'drives/[driveId]/subdomain',
        'drives/[driveId]/domains/*',
        'drives/[driveId]/publish-home',
        'pages/[pageId]/publish',
        'agent-workspaces/*',
      ],
      'drive-access-control': ['drives/[driveId]/members', 'drives/[driveId]/roles/*'],
    });
    // Every interim entry names at least one real route.
    const keys = routes.map((r) => r.key);
    for (const { route, d14Interim } of OAUTH_ALLOWLIST_DENY) {
      if (d14Interim) expect(keys.some((key) => matchesRoute(key, route)), route).toBe(true);
    }
  });

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

  // Point-guard hold pending Phase 2b / [D-15]: an agent trigger schedules or
  // starts an agent run executed as the owning user with no ceiling, so a route
  // admitting `oauth` that handles agent-trigger input must refuse it from an
  // OAuth principal through the shared refusal — never widen first, hold later.
  it('(c) every route admitting oauth that handles agent-trigger input applies the shared OAuth trigger refusal', () => {
    const TRIGGER_INPUT = /\bagentTrigger\b|\btriggerType\b|\bcreateTaskTriggerWorkflow\b|\bupsertCalendarTriggerWorkflow\w*\b|\bfireCompletionTrigger\b|\bsyncTaskDueDateTrigger\b|\bcancelTaskDueDateTrigger\b|\bresyncCalendarTriggerTimings\b|\bremoveCalendarTrigger\b/;
    const offenders = routes
      .filter((r) => r.lists.some((list) => list.includes('oauth')))
      .filter((r) => {
        const code = stripComments(r.source);
        return TRIGGER_INPUT.test(code) && !/\brefuseOAuthAgentTrigger\(/.test(code);
      })
      .map((r) => r.key)
      .sort();
    expect(
      offenders,
      'These routes admit OAuth and take agent-trigger input without refuseOAuthAgentTrigger (apps/web/src/lib/auth/oauth-agent-trigger-hold.ts).',
    ).toEqual([]);
  });

  // (d) A credential is its user NARROWED by scope and role. A route that admits
  // a scoped credential and asks a USER-keyed authority function (the user's
  // role, the user's page access, the user's drive universe, or a service told
  // to act as the user via `actingUserId`) decides with authority the credential
  // may not have — the commands and calendar-share role-ceiling escapes. Each such call must be annotated
  // with why the user's own identity is the right question there
  // (`// user-identity: <reason>` on the call's line or up to three lines above),
  // typically: it runs only in the unscoped-user branch, or it asks about a
  // DIFFERENT user than the caller.
  it('(d) user-keyed authority calls in routes admitting mcp or oauth are annotated user-identity', () => {
    const USER_KEYED = /\b(?:isDriveOwnerOrAdmin|getUserAccessLevel|canUser\w+|getUserDrivePermissions|isUserDriveMember|getUserAccessiblePagesInDrive\w*|getMemberDriveIds|getDriveIdsForUser|listAccessibleDrives|getDriveWithAccess|checkDriveAccess\w*)\(|\bactingUserId:\s*(?:auth\.)?userId\b/;
    const offenders = routes
      .filter((r) => r.lists.some((list) => list.includes('mcp') || list.includes('oauth')))
      .flatMap((r) => {
        const lines = r.source.split('\n');
        return lines.flatMap((line, index) => {
          const code = line.replace(/\/\/.*$/, '');
          if (!USER_KEYED.test(code) || /^\s*(?:import|export)\b|^\s*\*/.test(line)) return [];
          const context = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
          return /\/\/\s*user-identity:\s*\S/.test(context) ? [] : [`${r.key}: ${line.trim()}`];
        });
      })
      .sort();
    expect(offenders).toEqual([]);
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
    for (const key of INHERITED_DOOR_NOT_USED.keys()) expect(keys).toContain(key);
    for (const { route, file } of PENDING_PHASE_2B) {
      expect(keys).toContain(route);
      expect(file).toBe(`apps/web/src/app/api/${route}/route.ts`);
    }
  });
});
