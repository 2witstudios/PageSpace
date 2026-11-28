/**
 * Spec ORG-5: "Every org mutation is authorized by one shared org permission function used by web
 * routes, CLI, and MCP."
 *
 * The full route × caller matrix. Every handler of every org route file on disk is called as a
 * non-member, a Member, an Admin and the Owner, over a session, an unscoped MCP key (the credential the
 * CLI and MCP send, Spec X-1) and a key restricted to drives (refused everywhere but the directory).
 * The drive-org and join-request handlers have their own real-Postgres matrix
 * (api/drives/__tests__/drive-org-authorization-matrix.integration.test.ts).
 *
 * Authorization is NOT faked: the real gate runs the real requireOrgRole over a faked membership
 * lookup. The org sign-in policy is faked to refuse everyone, so a caller the role check
 * admits stops at the very next step of the gate with `org_reauthentication_required` — proof the
 * handler reached the shared function, passed it, and never touched a service before it.
 * A route that skipped the gate, asked for the wrong minimum role, or ran a service first fails here.
 *
 * Expected minimum roles are written out below, one row per handler; a handler on disk without a row
 * (a new route) fails the completeness check, so the matrix cannot silently fall behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextResponse } from 'next/server';
import type { OrgRole } from '@pagespace/db/schema/organizations';

type Credential = 'session' | 'mcp' | 'drive-key';
const caller = vi.hoisted(() => ({ credential: 'session' as 'session' | 'mcp' | 'drive-key' }));

vi.mock('@/lib/auth', () => ({
  // The real admission rule of authenticateRequestWithOptions: a credential type the route does not
  // list is a 401 before anything else runs.
  authenticateRequestWithOptions: vi.fn(async (_request: Request, options: { allow: readonly string[] }) => {
    const tokenType = caller.credential === 'session' ? 'session' : 'mcp';
    if (!options.allow.includes(tokenType)) {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    return caller.credential === 'session'
      ? { userId: 'user_caller', tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 }
      : { userId: 'user_caller', tokenVersion: 0, tokenType: 'mcp', tokenId: 'tok', role: 'user', adminRoleVersion: 0, allowedDriveIds: caller.credential === 'drive-key' ? ['drive_scoped'] : [] };
  }),
  isAuthError: (result: object) => 'error' in result,
  getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [],
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/organizations/repository')>()),
  findMembershipRole: vi.fn(),
}));
// Everyone the role check admits is stopped by the sign-in policy, the gate's next step.
vi.mock('@pagespace/lib/permissions/actor-authentication', () => ({
  checkActorOrgAuthentication: vi.fn(async () => ({ allowed: false, code: 'org_reauthentication_required' })),
  drivePolicyOrgId: vi.fn(async () => null),
}));

import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { checkActorOrgAuthentication } from '@pagespace/lib/permissions/actor-authentication';

/** How a handler admits credentials (org-route-auth's postures). */
type Posture = 'token' | 'directory' | 'session-read' | 'session-write' | 'money-write' | 'no-org';
interface Row {
  minRole: OrgRole | null;
  posture: Posture;
  /** false: the org's sign-in policy is never asked (leaving only restricts — authorizeOrgDeparture). */
  signInPolicy?: false;
}

const ORGS_DIR = join(__dirname, '..');

/** One row per handler: `<route path under /api/orgs> <METHOD>`. */
const MATRIX: Record<string, Row> = {
  '/ GET': { minRole: null, posture: 'no-org' },
  '/ POST': { minRole: null, posture: 'money-write' },
  '/invitations/accept POST': { minRole: null, posture: 'no-org' },
  '/domains/verify-email POST': { minRole: null, posture: 'no-org' },
  '/[orgId] GET': { minRole: 'MEMBER', posture: 'token' },
  '/[orgId] PATCH': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId] DELETE': { minRole: 'OWNER', posture: 'money-write' },
  '/[orgId]/audit GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/audit/export GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/avatar POST': { minRole: 'ADMIN', posture: 'session-write' },
  '/[orgId]/avatar DELETE': { minRole: 'ADMIN', posture: 'session-write' },
  '/[orgId]/avatar/[filename] GET': { minRole: 'MEMBER', posture: 'session-read' },
  '/[orgId]/automations GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/automations/[kind]/[automationId] DELETE': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/automations/[kind]/[automationId]/reassign POST': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/billing/invoices GET': { minRole: 'ADMIN', posture: 'session-read' },
  '/[orgId]/billing/portal POST': { minRole: 'ADMIN', posture: 'money-write' },
  '/[orgId]/billing/seats GET': { minRole: 'ADMIN', posture: 'session-read' },
  '/[orgId]/billing/seats PATCH': { minRole: 'OWNER', posture: 'money-write' },
  '/[orgId]/billing/storage GET': { minRole: 'ADMIN', posture: 'session-read' },
  '/[orgId]/billing/storage PATCH': { minRole: 'OWNER', posture: 'money-write' },
  '/[orgId]/billing/subscription POST': { minRole: 'ADMIN', posture: 'money-write' },
  '/[orgId]/domains GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/domains POST': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/domains/[domainId] DELETE': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/domains/[domainId]/verify POST': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/drives GET': { minRole: 'MEMBER', posture: 'directory' },
  '/[orgId]/drives/trashed GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/drives/usage GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/guest-approvals GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/guest-approvals/[holdId] POST': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/guests GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/invitations GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/invitations POST': { minRole: 'MEMBER', posture: 'token' },
  '/[orgId]/invitations/[invitationId] DELETE': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/invitations/[invitationId]/resend POST': { minRole: 'MEMBER', posture: 'token' },
  '/[orgId]/leave POST': { minRole: 'MEMBER', posture: 'token', signInPolicy: false },
  '/[orgId]/members GET': { minRole: 'MEMBER', posture: 'token' },
  '/[orgId]/members/activity GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/members/[userId] PATCH': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/members/[userId] DELETE': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/members/[userId]/seat-cap PUT': { minRole: 'ADMIN', posture: 'money-write' },
  '/[orgId]/members/[userId]/seat-cap DELETE': { minRole: 'ADMIN', posture: 'money-write' },
  '/[orgId]/policies GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/policies PATCH': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/policies/suspended GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/policies/sign-in-preview GET': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/pool GET': { minRole: 'ADMIN', posture: 'session-read' },
  '/[orgId]/pool PATCH': { minRole: 'ADMIN', posture: 'session-write' },
  '/[orgId]/seat-caps GET': { minRole: 'ADMIN', posture: 'session-read' },
  '/[orgId]/suppressions/clear POST': { minRole: 'ADMIN', posture: 'token' },
  '/[orgId]/transfer-ownership POST': { minRole: 'OWNER', posture: 'money-write' },
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

/** `/[orgId]/members/[userId]` for `<ORGS_DIR>/[orgId]/members/[userId]/route.ts`. */
const routeKey = (file: string): string => {
  const rel = relative(ORGS_DIR, file).split(sep).slice(0, -1).join('/');
  return `/${rel}`;
};

const ORG_ID = 'org_northwind';
const paramsFor = (route: string): Record<string, string> =>
  Object.fromEntries([...route.matchAll(/\[(\w+)\]/g)].map(([, name]) => [name, name === 'orgId' ? ORG_ID : `${name}_1`]));

const FILES = routeFiles(ORGS_DIR);
const HANDLERS: Array<{ key: string; route: string; method: Method; file: string }> = [];
for (const file of FILES) {
  const route = routeKey(file);
  const source = readFileSync(file, 'utf8');
  for (const method of METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+function|function|const|let)\\s+${method}\\b`).test(source)) {
      HANDLERS.push({ key: `${route} ${method}`, route, method, file });
    }
  }
}

const CALLERS: Array<{ label: string; role: OrgRole | null }> = [
  { label: 'a non-member', role: null },
  { label: 'a Member', role: 'MEMBER' },
  { label: 'an Admin', role: 'ADMIN' },
  { label: 'the Owner', role: 'OWNER' },
];
const RANK: Record<OrgRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

/** What the gate answers, by posture, role and credential — `null` code means the role check admitted the caller. */
function expected(row: Row, role: OrgRole | null, credential: Credential): { status: number; code: string | null } {
  if (credential !== 'session' && (row.posture === 'session-read' || row.posture === 'session-write')) return { status: 401, code: null };
  if (credential !== 'session' && row.posture === 'money-write') return { status: 403, code: 'mcp_token_cannot_move_money' };
  // A key restricted to drives acts on nothing org-wide; only the directory admits it (filtered to its drives).
  if (credential === 'drive-key' && row.posture !== 'directory') return { status: 403, code: 'token_scope_refused' };
  if (row.minRole === null) return { status: -1, code: null };
  if (role === null) return { status: 404, code: 'org_not_found' };
  if (RANK[role] < RANK[row.minRole]) return { status: 403, code: 'insufficient_role' };
  // Past the role check: the sign-in policy stops the caller, except on a route that never asks it.
  if (row.signInPolicy === false) return { status: -2, code: null };
  return { status: 403, code: 'org_reauthentication_required' };
}

async function call(entry: (typeof HANDLERS)[number]): Promise<Response> {
  const mod = (await import(entry.file)) as Partial<Record<Method, Handler>>;
  const handler = mod[entry.method];
  if (!handler) throw new Error(`${entry.key} has no handler`);
  const request = new Request(`https://example.test/api/orgs${entry.route}`, {
    method: entry.method,
    headers: { 'content-type': 'application/json' },
    ...(entry.method === 'GET' ? {} : { body: '{}' }),
  });
  return handler(request, { params: Promise.resolve(paramsFor(entry.route)) });
}

beforeEach(() => {
  vi.clearAllMocks();
  caller.credential = 'session';
});

describe('ORG-5 every org route authorizes through the one shared org permission function, for web, CLI and MCP credentials', () => {
  it('ORG-5 the matrix has exactly one row per org route handler on disk', () => {
    expect(HANDLERS.map((h) => h.key).sort()).toEqual(Object.keys(MATRIX).sort());
  });

  for (const entry of HANDLERS) {
    const row = MATRIX[entry.key];
    if (!row || row.minRole === null) continue;
    for (const credential of ['session', 'mcp', 'drive-key'] as const) {
      for (const who of CALLERS) {
        const want = expected(row, who.role, credential);
        it(`ORG-5 ${entry.key} as ${who.label} over ${credential === 'mcp' ? 'an MCP key' : credential === 'drive-key' ? 'a drive-restricted MCP key' : 'a session'} answers ${want.status}${want.code ? ` ${want.code}` : ''}`, async () => {
          caller.credential = credential;
          vi.mocked(findMembershipRole).mockResolvedValue(who.role);
          const response = await call(entry);
          if (want.status === -2) {
            // Admitted by the role check and past the gate: the sign-in policy was never asked.
            expect(findMembershipRole).toHaveBeenCalledWith(ORG_ID, 'user_caller');
            expect(checkActorOrgAuthentication).not.toHaveBeenCalled();
            return;
          }
          expect(response.status).toBe(want.status);
          if (want.code) expect((await response.json()).code).toBe(want.code);
          if (want.code === 'org_reauthentication_required') {
            // Admitted by requireOrgRole for this org and caller, then stopped by the gate's next step.
            expect(findMembershipRole).toHaveBeenCalledWith(ORG_ID, 'user_caller');
            expect(checkActorOrgAuthentication).toHaveBeenCalledWith(expect.objectContaining({ via: 'credential', userId: 'user_caller', authentication: null }), ORG_ID);
          }
          if (want.status === 401 || want.code === 'mcp_token_cannot_move_money' || want.code === 'token_scope_refused') {
            // Refused on the credential alone: no membership, and so no org fact, was read.
            expect(findMembershipRole).not.toHaveBeenCalled();
          }
        });
      }
    }
  }

  // The four handlers with no org in the path (list, create, accept by invite token, confirm a mailed
  // domain proof) authenticate without a role; their money and credential rules still hold.
  it('ORG-5 card-checkout org create refuses an MCP key by name ([D-OW-26]) and never reads a membership', async () => {
    caller.credential = 'mcp';
    const create = HANDLERS.find((h) => h.key === '/ POST');
    if (!create) throw new Error('missing POST /api/orgs');
    const response = await call(create);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('mcp_token_cannot_move_money');
    expect(findMembershipRole).not.toHaveBeenCalled();
  });
});
