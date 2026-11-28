/**
 * Spec ORG-5: "Every org mutation is authorized by one shared org permission function used by web
 * routes, CLI, and MCP." The structural half (the behavioural half is org-authorization-matrix.test.ts).
 *
 * A static scan, so a new route or a new service cannot ship a second org rank rule:
 *   1. every org route handler file (/api/orgs/**, the drive-org routes, join requests) goes through the
 *      shared gate in org-route-auth — never authenticates on its own;
 *   2. a route with no org in its path either needs no role (list, card-checkout create, invite or
 *      domain-proof tokens) or hands the decision to a named service that asks requireOrgRole;
 *   3. every org authority decision in lib asks the shared function (requireOrgRole, decideOrgRole or
 *      holdsOrgRole — organizations/authorize(-core).ts), and nothing in lib or the web routes compares
 *      an org role to a rank by hand or reads the rank table outside org-roles.ts.
 * The CLI and MCP reach org data only through these routes (Spec X-1: every SDK operation is a web
 * route, guarded in packages/cli x1-org-route-parity.test.ts), so they are authorized by the same function.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const API = join(__dirname, '..', '..');
const WEB_SRC = join(API, '..', '..');
const LIB_SRC = join(WEB_SRC, '..', '..', '..', 'packages', 'lib', 'src');

function files(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : files(path, keep);
    return keep(name) ? [path] : [];
  });
}

const ROUTE_ROOTS = [join(API, 'orgs'), join(API, 'drives', '[driveId]', 'org'), join(API, 'drives', '[driveId]', 'join-requests')];
const ROUTES = ROUTE_ROOTS.flatMap((root) => files(root, (name) => name === 'route.ts'));
const rel = (path: string, from: string) => relative(from, path).split(sep).join('/');
const read = (path: string) => readFileSync(path, 'utf8');

/**
 * Routes that authenticate through the gate but carry no org role check of their own, and why. A
 * `service` is the lib module whose decision runs through requireOrgRole for the org it acts on.
 */
const NO_ORG_ROLE_IN_ROUTE: Record<string, { reason: string; service?: string }> = {
  'orgs/route.ts': { reason: 'GET lists only the caller\'s own orgs; POST creates one (no org exists yet)' },
  'orgs/invitations/accept/route.ts': { reason: 'the emailed invite token, bound to the invited address, is the authority; the caller is not a member yet' },
  'orgs/domains/verify-email/route.ts': { reason: 'the mailed domain proof token is the authority; the confirmer is usually IT, not a member' },
  'drives/[driveId]/org/route.ts': { reason: 'the org comes from the drive or the body', service: 'services/org-drive-service-deps.ts' },
  'drives/[driveId]/org/lead/route.ts': { reason: 'the org comes from the drive', service: 'services/org-drive-service-deps.ts' },
  'drives/[driveId]/join-requests/route.ts': { reason: 'the org comes from the drive', service: 'services/drive-join-request-service.ts' },
  'drives/[driveId]/join-requests/[requestId]/route.ts': { reason: 'the org comes from the drive', service: 'services/drive-join-request-service.ts' },
};

/** Every lib module that makes an org authority decision, and the shared function it must ask. */
const ORG_AUTHORITY_MODULES: Record<string, 'requireOrgRole' | 'decideOrgRole' | 'holdsOrgRole'> = {
  'services/org-drive-service-deps.ts': 'requireOrgRole',
  'services/drive-join-request-service.ts': 'requireOrgRole',
  'organizations/membership.ts': 'decideOrgRole',
  'permissions/automation-ownership.ts': 'decideOrgRole',
  'permissions/wallet-access.ts': 'decideOrgRole',
  'organizations/org-drive-ownership.ts': 'holdsOrgRole',
  'organizations/org-action-decisions.ts': 'holdsOrgRole',
  'organizations/invitations.ts': 'holdsOrgRole',
  'organizations/status-core.ts': 'holdsOrgRole',
  'organizations/seats.ts': 'holdsOrgRole',
  'permissions/app-unpark-authority.ts': 'holdsOrgRole',
  'permissions/drive-relationship.ts': 'holdsOrgRole',
  'permissions/drive-join-requests.ts': 'holdsOrgRole',
  'permissions/org-access.ts': 'holdsOrgRole',
  'services/drive-wallet-service.ts': 'holdsOrgRole',
};

/** A hand-rolled org rank check: an org/actor role compared to OWNER or ADMIN, or the rank table read directly. */
const HAND_ROLLED_ORG_RANK = /\b[a-zA-Z]*(?:[oO]rgRole|actorRole)\??\s*(?:===|!==)\s*'(?:OWNER|ADMIN)'|\bgate\.role\s*(?:===|!==)|ORG_ROLE_RANK\s*\[/;
/** The only modules that may hold the rank rule itself. */
const RANK_RULE_HOMES = new Set(['organizations/org-roles.ts']);

describe('ORG-5 every org route and org authority decision goes through the one shared org permission function', () => {
  it('ORG-5 every org route file authenticates only through the shared org gate', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(40);
    for (const route of ROUTES) {
      const source = read(route);
      const name = rel(route, API);
      expect(source, `${name} must use org-route-auth`).toMatch(/from '@\/lib\/orgs\/org-route-auth'/);
      expect(source, `${name} must not authenticate on its own`).not.toMatch(/authenticateRequestWithOptions/);
      expect(source, `${name} must call the gate`).toMatch(/\b(?:authorizeOrgRequest|authorizeOrgBillingRequest|authorizeOrgDeparture|authenticateOrgRequest)\(/);
    }
  });

  it('ORG-5 a route that does not ask requireOrgRole itself is listed with its reason, and its service asks it', () => {
    const unlisted = ROUTES.map((route) => [rel(route, API), read(route)] as const)
      .filter(([, source]) => !/\b(?:authorizeOrgRequest|authorizeOrgBillingRequest|authorizeOrgDeparture)\(/.test(source))
      .map(([name]) => name);
    expect(unlisted.sort()).toEqual(Object.keys(NO_ORG_ROLE_IN_ROUTE).sort());
    for (const { service } of Object.values(NO_ORG_ROLE_IN_ROUTE)) {
      if (!service) continue;
      expect(read(join(LIB_SRC, service)), service).toMatch(/import \{[^}]*\brequireOrgRole\b[^}]*\} from '\.\.\/organizations\/authorize'/);
    }
  });

  it('ORG-5 every lib org authority decision imports the shared function', () => {
    for (const [module, fn] of Object.entries(ORG_AUTHORITY_MODULES)) {
      const source = read(join(LIB_SRC, module));
      expect(source, `${module} must import ${fn}`).toMatch(new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\} from '(?:\\.\\.?/organizations/|\\./)authorize(?:-core)?'`));
      expect(source, `${module} must call ${fn}`).toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });

  it('ORG-5 nothing in lib or the web routes compares an org role by hand or reads the rank table outside org-roles.ts', () => {
    const lib = files(LIB_SRC, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((path) => [rel(path, LIB_SRC), path] as const)
      .filter(([name]) => !RANK_RULE_HOMES.has(name));
    const web = [join(WEB_SRC, 'app', 'api'), join(WEB_SRC, 'lib')]
      .flatMap((dir) => files(dir, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')))
      .map((path) => [rel(path, WEB_SRC), path] as const);
    const offenders = [...lib, ...web].flatMap(([name, path]) =>
      read(path).split('\n').flatMap((line, i) => (HAND_ROLLED_ORG_RANK.test(line) ? [`${name}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
