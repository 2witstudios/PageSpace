/**
 * `operations/drives.ts` — org ownership of a drive (Spec X-1; DRV-1..DRV-4, DRV-6): what
 * `drives.list` now shows (orgId, orgVisibility), creating a drive in an org, move in/out,
 * visibility, lead, and join requests. Each is pinned to the web route it calls.
 */
import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import {
  answerDriveJoinRequest,
  createDrive,
  listDriveJoinRequests,
  listDrives,
  moveDriveOutOfOrg,
  moveDriveToOrg,
  requestToJoinDrive,
  setDriveOrgLead,
  setDriveOrgVisibility,
  withdrawDriveJoinRequest,
} from '../drives.js';

const config = { baseUrl: 'https://pagespace.ai' };
const anyOp = (op: unknown) => op as Parameters<typeof buildRequest>[0];
const body = (request: { body?: string }) => (request.body === undefined ? undefined : JSON.parse(request.body));

const LISTED = {
  id: 'd1',
  name: 'Research',
  slug: 'research',
  ownerId: 'u1',
  kind: 'STANDARD',
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
  homePageId: null,
};

const ROW = {
  id: 'd1',
  name: 'Research',
  slug: 'research',
  ownerId: 'u1',
  kind: 'STANDARD',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  drivePrompt: null,
  publishSubdomain: null,
  homePageId: null,
  publishDefaultOgImageUrl: null,
  orgId: 'o1',
  orgVisibility: 'RESTRICTED',
};

const JOIN_REQUEST = {
  id: 'jr1',
  driveId: 'd1',
  userId: 'u2',
  status: 'pending',
  message: null,
  requestedAt: '2026-09-17T00:00:00.000Z',
  decidedAt: null,
  decidedBy: null,
};

describe('drives.list — org ownership is visible', () => {
  it('X-1 (partial) keeps orgId and orgVisibility instead of stripping them', () => {
    const parsed = listDrives.outputSchema.parse([{ ...LISTED, orgId: 'o1', orgVisibility: 'PRIVATE' }]);
    expect(parsed[0].orgId).toBe('o1');
    expect(parsed[0].orgVisibility).toBe('PRIVATE');
  });

  it('X-1 (partial) a personal drive lists orgId null; a server predating orgs still parses', () => {
    expect(listDrives.outputSchema.parse([{ ...LISTED, orgId: null, orgVisibility: 'OPEN' }])[0].orgId).toBeNull();
    expect(listDrives.outputSchema.safeParse([LISTED]).success).toBe(true);
    expect(listDrives.outputSchema.safeParse([{ ...LISTED, orgVisibility: 'SECRET' }]).success).toBe(false);
  });
});

describe('drives.create in an org (DRV-3)', () => {
  it('X-1 (partial) sends orgId and orgVisibility to the one drive-create route', () => {
    const request = buildRequest(createDrive, { name: 'Research', orgId: 'o1', orgVisibility: 'RESTRICTED' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/drives');
    expect(body(request)).toEqual({ name: 'Research', orgId: 'o1', orgVisibility: 'RESTRICTED' });
    expect(createDrive.inputSchema.safeParse({ name: 'x', orgVisibility: 'HIDDEN' }).success).toBe(false);
    expect(buildRequest(createDrive, { name: 'Mine' }, config).body).toBe(JSON.stringify({ name: 'Mine' }));
  });
});

describe('drive-org writes — route, method, payload', () => {
  const cases = [
    { op: moveDriveToOrg, input: { driveId: 'd1', orgId: 'o1', orgVisibility: 'OPEN' }, method: 'PUT', url: '/api/drives/d1/org', sent: { orgId: 'o1', orgVisibility: 'OPEN' } },
    { op: moveDriveOutOfOrg, input: { driveId: 'd1', implicitMembers: 'keep' }, method: 'DELETE', url: '/api/drives/d1/org', sent: { implicitMembers: 'keep' } },
    { op: setDriveOrgVisibility, input: { driveId: 'd1', orgVisibility: 'PRIVATE' }, method: 'PATCH', url: '/api/drives/d1/org', sent: { orgVisibility: 'PRIVATE' } },
    { op: setDriveOrgLead, input: { driveId: 'd1', userId: 'u2' }, method: 'PUT', url: '/api/drives/d1/org/lead', sent: { userId: 'u2' } },
    { op: listDriveJoinRequests, input: { driveId: 'd1' }, method: 'GET', url: '/api/drives/d1/join-requests', sent: undefined },
    { op: requestToJoinDrive, input: { driveId: 'd1', message: 'please' }, method: 'POST', url: '/api/drives/d1/join-requests', sent: { message: 'please' } },
    { op: answerDriveJoinRequest, input: { driveId: 'd1', requestId: 'jr1', decision: 'approve' }, method: 'PATCH', url: '/api/drives/d1/join-requests/jr1', sent: { decision: 'approve' } },
    { op: withdrawDriveJoinRequest, input: { driveId: 'd1', requestId: 'jr1' }, method: 'DELETE', url: '/api/drives/d1/join-requests/jr1', sent: undefined },
  ] as const;

  for (const c of cases) {
    it(`X-1 (partial) ${c.op.name} is ${c.method} ${c.url}`, () => {
      expect(c.op.inputSchema.safeParse(c.input).success).toBe(true);
      const request = buildRequest(anyOp(c.op), c.input as Record<string, unknown>, config);
      expect(request.method).toBe(c.method);
      expect(request.url).toBe(`https://pagespace.ai${c.url}`);
      expect(body(request)).toEqual(c.sent);
      expect(c.op.requiredScope).toBe('account');
    });
  }

  it('X-1 (partial) moving a drive out names the keep-or-remove choice (no default) and is destructive', () => {
    expect(moveDriveOutOfOrg.inputSchema.safeParse({ driveId: 'd1' }).success).toBe(false);
    expect(moveDriveOutOfOrg.destructive).toBe(true);
    expect(moveDriveToOrg.destructive).toBeUndefined();
  });

  it('X-1 (partial) a join request message is bounded and the decision is approve or deny', () => {
    expect(requestToJoinDrive.inputSchema.safeParse({ driveId: 'd1', message: 'x'.repeat(501) }).success).toBe(false);
    expect(answerDriveJoinRequest.inputSchema.safeParse({ driveId: 'd1', requestId: 'jr1', decision: 'maybe' }).success).toBe(false);
  });

  it('X-1 (partial) the answers parse: the drive row with its org, the join request with its status', () => {
    expect(moveDriveToOrg.outputSchema.safeParse({ drive: ROW, storageReattribution: { status: 'applied', direction: 'into_org', movedBytes: 10, deltas: [] } }).success).toBe(true);
    expect(setDriveOrgVisibility.outputSchema.safeParse({ drive: ROW }).success).toBe(true);
    expect(setDriveOrgLead.outputSchema.safeParse({ drive: { ...ROW, ownerId: 'u2' } }).success).toBe(true);
    expect(requestToJoinDrive.outputSchema.safeParse({ request: JOIN_REQUEST }).success).toBe(true);
    expect(answerDriveJoinRequest.outputSchema.safeParse({ request: { ...JOIN_REQUEST, status: 'approved' }, admitted: true }).success).toBe(true);
    expect(withdrawDriveJoinRequest.outputSchema.safeParse({ request: { ...JOIN_REQUEST, status: 'withdrawn' } }).success).toBe(true);
    expect(listDriveJoinRequests.outputSchema.safeParse({
      requests: [{ id: 'jr1', userId: 'u2', name: 'Lena', email: 'l@x.co', image: null, message: null, requestedAt: '2026-09-17T00:00:00.000Z' }],
    }).success).toBe(true);
  });

  it('X-1 (partial) every drive-org description states the key rules', () => {
    for (const op of [moveDriveToOrg, moveDriveOutOfOrg, setDriveOrgVisibility, setDriveOrgLead, listDriveJoinRequests, requestToJoinDrive, answerDriveJoinRequest, withdrawDriveJoinRequest]) {
      expect(op.description, op.name).toContain('no drive restriction');
      expect(op.description, op.name).toContain('org_strong_sign_in_required');
    }
  });
});
