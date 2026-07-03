import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { listDriveMembers } from '../members.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against apps/web/src/app/api/drives/[driveId]/members/route.ts GET (MemberWithDetails[] + pendingInvites + currentUserRole). */
const memberFixture = {
  id: 'm1abc',
  userId: 'u1abc',
  role: 'MEMBER',
  invitedBy: 'u0owner',
  invitedAt: '2026-01-01T00:00:00.000Z',
  acceptedAt: '2026-01-02T00:00:00.000Z',
  lastAccessedAt: '2026-01-03T00:00:00.000Z',
  user: { id: 'u1abc', email: 'ada@example.com', name: 'Ada' },
  profile: { username: 'ada', displayName: 'Ada Lovelace', avatarUrl: null },
  customRole: null,
  permissionCounts: { view: 3, edit: 1, share: 0 },
};

const ownerFixture = {
  id: 'owner-u0owner',
  userId: 'u0owner',
  role: 'OWNER',
  invitedBy: null,
  invitedAt: null,
  acceptedAt: null,
  lastAccessedAt: null,
  user: { id: 'u0owner', email: 'owner@example.com', name: 'Owner' },
  profile: { username: null, displayName: null, avatarUrl: null },
  customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 },
};

const pendingInviteFixture = {
  id: 'inv1abc',
  email: 'pending@example.com',
  role: 'MEMBER',
  customRoleId: null,
  customRoleName: null,
  customRoleColor: null,
  driveId: 'd1abc',
  invitedByName: 'Owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-02-01T00:00:00.000Z',
};

describe('members.list — request shape', () => {
  it('interpolates :driveId into the path and sends no body', () => {
    const request = buildRequest(listDriveMembers, { driveId: 'd1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/members');
    expect(request.body).toBeUndefined();
  });
});

describe('members.list — response contract', () => {
  it('parses {members, pendingInvites, currentUserRole} (route truth §2.15)', () => {
    const body = { members: [ownerFixture, memberFixture], pendingInvites: [pendingInviteFixture], currentUserRole: 'OWNER' };
    const result = parseResponse(listDriveMembers, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('parses an empty pendingInvites array for a plain MEMBER caller (route always returns an array)', () => {
    const body = { members: [ownerFixture, memberFixture], pendingInvites: [], currentUserRole: 'MEMBER' };
    const result = parseResponse(listDriveMembers, 200, new Headers(), JSON.stringify(body));
    expect(result).toEqual(body);
  });

  it('rejects a response missing currentUserRole', () => {
    const malformed = { members: [], pendingInvites: [] };
    const result = parseResponse(listDriveMembers, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (not a drive member) as PermissionDeniedError', () => {
    const result = parseResponse(listDriveMembers, 403, new Headers(), JSON.stringify({ error: 'You must be a drive member to view members' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });

  it('classifies a 404 (drive not found) as NotFoundError', () => {
    const result = parseResponse(listDriveMembers, 404, new Headers(), JSON.stringify({ error: 'Drive not found' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('members.list — metadata', () => {
  it('declares drive as the minimum required scope (member-gated view)', () => {
    expect(listDriveMembers.requiredScope).toBe('drive');
  });
});
