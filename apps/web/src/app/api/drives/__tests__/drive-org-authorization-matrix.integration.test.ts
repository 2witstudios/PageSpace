/**
 * Spec ORG-5 / X-1: the key-enabled drive-org and join-request handlers, as a role × credential matrix
 * against a REAL Postgres. These routes have no org in their path, so the route gate authenticates and
 * the SERVICE authorizes through requireOrgRole (org-drive-service-deps, drive-join-request-service); the
 * services, the org, its members and drives are all real here — only the credential is faked.
 *
 * Every handler is called by the org Owner, an Admin, a plain Member and an outsider (none of them the
 * drive's lead, so org role is the only power in play), each over a signed-in session, an unscoped MCP
 * key, and a key restricted to the very drive it acts on. A session and an unscoped key must get the
 * SAME answer (the CLI and MCP are authorized exactly as the web); a drive-restricted key is refused
 * (403 `token_scope_refused`) on every one of them, writes included, and changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { organizations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [],
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/permissions/drive-relationship-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/drive-relationship-loader')>()),
  recordOrgPowerDriveAction: vi.fn(async () => {}),
}));
vi.mock('@/lib/websocket', () => ({ broadcastDriveEvent: vi.fn(async () => {}), createDriveEventPayload: vi.fn(() => ({})) }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { PUT as moveIn, DELETE as moveOut, PATCH as setVisibility } from '../[driveId]/org/route';
import { PUT as setLead } from '../[driveId]/org/lead/route';
import { GET as listJoin, POST as askJoin } from '../[driveId]/join-requests/route';
import { PATCH as answerJoin, DELETE as withdrawJoin } from '../[driveId]/join-requests/[requestId]/route';

type Who = 'OWNER' | 'ADMIN' | 'MEMBER' | 'outsider';
type Credential = 'session' | 'key' | 'drive-key';
const created = { orgs: [] as string[], users: [] as string[] };

interface World {
  orgId: string;
  caller: string;
  requester: string;
  research: string;
  personal: string;
  requestId: string;
}

/** An org with a Restricted drive led by someone else, a member's pending join request, and the caller in role `who`. */
async function world(who: Who): Promise<World> {
  const [owner, lead, requester, other] = await factories.createUsers(4);
  const caller = who === 'OWNER' ? owner : await factories.createUser();
  created.users.push(owner.id, lead.id, requester.id, other.id, ...(who === 'OWNER' ? [] : [caller.id]));
  // No subscription, so the org is lapsed ([D-OW-33]): a change that would loosen access (moving a drive in, a new lead,
  // admitting a requester) is refused 402 AFTER authorization passed, so 402 still means "authorized" in the table below.
  const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `northwind-${createId()}`, ownerId: owner.id }).returning();
  created.orgs.push(org.id);
  const members: Array<{ userId: string; role: OrgRole }> = [
    { userId: owner.id, role: 'OWNER' },
    { userId: lead.id, role: 'MEMBER' },
    { userId: requester.id, role: 'MEMBER' },
    { userId: other.id, role: 'MEMBER' },
  ];
  if (who === 'ADMIN' || who === 'MEMBER') members.push({ userId: caller.id, role: who });
  await db.insert(orgMembers).values(members.map((m) => ({ orgId: org.id, ...m })));
  const research = await factories.createDrive(lead.id, { orgId: org.id, orgVisibility: 'RESTRICTED' });
  const personal = await factories.createDrive(caller.id);
  const [request] = await db.insert(driveJoinRequests).values({ driveId: research.id, userId: requester.id }).returning();
  return { orgId: org.id, caller: caller.id, requester: requester.id, research: research.id, personal: personal.id, requestId: request.id };
}

const credentialFor = (credential: Credential, userId: string, driveId: string): MCPAuthResult | SessionAuthResult =>
  credential === 'session'
    ? { userId, tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 }
    : { userId, tokenVersion: 0, tokenType: 'mcp', tokenId: 'tok', role: 'user', adminRoleVersion: 0, allowedDriveIds: credential === 'drive-key' ? [driveId] : [] };

const json = (method: string, body?: unknown) =>
  new Request('https://x.test/api/drives', { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const drive = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
const request = (driveId: string, requestId: string) => ({ params: Promise.resolve({ driveId, requestId }) });

interface Handler {
  name: string;
  /** The drive the handler acts on (a restricted key is scoped to exactly it). */
  driveOf: (w: World) => string;
  call: (w: World) => Promise<Response>;
  /** The answer for a session or an unscoped key, by the caller's org role. */
  expected: Record<Who, number>;
}

const HANDLERS: Handler[] = [
  { name: 'PUT /api/drives/[driveId]/org (move in)', driveOf: (w) => w.personal,
    call: (w) => moveIn(json('PUT', { orgId: w.orgId }), drive(w.personal)),
    expected: { OWNER: 402, ADMIN: 402, MEMBER: 402, outsider: 403 } },
  { name: 'DELETE /api/drives/[driveId]/org (move out)', driveOf: (w) => w.research,
    call: (w) => moveOut(json('DELETE', { implicitMembers: 'keep' }), drive(w.research)),
    expected: { OWNER: 200, ADMIN: 200, MEMBER: 403, outsider: 403 } },
  { name: 'PATCH /api/drives/[driveId]/org (visibility)', driveOf: (w) => w.research,
    call: (w) => setVisibility(json('PATCH', { orgVisibility: 'PRIVATE' }), drive(w.research)),
    expected: { OWNER: 200, ADMIN: 200, MEMBER: 403, outsider: 403 } },
  { name: 'PUT /api/drives/[driveId]/org/lead', driveOf: (w) => w.research,
    call: (w) => setLead(json('PUT', { userId: w.requester }), drive(w.research)),
    expected: { OWNER: 402, ADMIN: 402, MEMBER: 403, outsider: 403 } },
  { name: 'GET /api/drives/[driveId]/join-requests', driveOf: (w) => w.research,
    call: (w) => listJoin(json('GET'), drive(w.research)),
    expected: { OWNER: 200, ADMIN: 200, MEMBER: 403, outsider: 404 } },
  { name: 'POST /api/drives/[driveId]/join-requests', driveOf: (w) => w.research,
    call: (w) => askJoin(json('POST', {}), drive(w.research)),
    // Any org member may ask (asking grants nothing); an outsider learns nothing of the drive.
    expected: { OWNER: 201, ADMIN: 201, MEMBER: 201, outsider: 404 } },
  { name: 'PATCH /api/drives/[driveId]/join-requests/[requestId] (approve)', driveOf: (w) => w.research,
    call: (w) => answerJoin(json('PATCH', { decision: 'approve' }), request(w.research, w.requestId)),
    expected: { OWNER: 402, ADMIN: 402, MEMBER: 403, outsider: 404 } },
  { name: "DELETE /api/drives/[driveId]/join-requests/[requestId] (withdraw someone else's)", driveOf: (w) => w.research,
    call: (w) => withdrawJoin(json('DELETE'), request(w.research, w.requestId)),
    // Withdrawing is the requester's alone: no org role reaches another person's request.
    expected: { OWNER: 404, ADMIN: 404, MEMBER: 404, outsider: 404 } },
];

const WHO: Who[] = ['OWNER', 'ADMIN', 'MEMBER', 'outsider'];
const CREDENTIALS: Credential[] = ['session', 'key', 'drive-key'];

describe('ORG-5 X-1 the drive-org and join-request handlers authorize every role the same over a session and a key; a drive-restricted key is refused', () => {
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('drive-org-authorization-matrix.integration.test.ts', error);
    }
    vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    const orgIds = created.orgs.splice(0);
    const userIds = created.users.splice(0);
    if (orgIds.length > 0) {
      await db.delete(drives).where(inArray(drives.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) {
      await db.delete(drives).where(inArray(drives.ownerId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  for (const handler of HANDLERS) {
    for (const who of WHO) {
      for (const credential of CREDENTIALS) {
        const status = credential === 'drive-key' ? 403 : handler.expected[who];
        it(`ORG-5 ${handler.name} as ${who === 'outsider' ? 'an outsider' : `the org ${who}`} over ${credential === 'session' ? 'a session' : credential === 'key' ? 'an unscoped key' : 'a key restricted to that drive'} answers ${status}`, async () => {
          if (!dbAvailable) return;
          const w = await world(who);
          const before = await db.select().from(drives).where(eq(drives.id, handler.driveOf(w)));
          vi.mocked(authenticateRequestWithOptions).mockResolvedValue(credentialFor(credential, w.caller, handler.driveOf(w)));
          const response = await handler.call(w);
          expect(response.status).toBe(status);
          if (credential === 'drive-key') {
            expect((await response.json()).code).toBe('token_scope_refused');
            expect(await db.select().from(drives).where(eq(drives.id, handler.driveOf(w)))).toEqual(before);
          }
        });
      }
    }
  }
});
