/**
 * The tenant/membership gather both tiers (web routes, the realtime shell
 * bridge) call through — the shared fix for the fail-open/fail-closed
 * divergence (audit #2265 finding 1): a vanished drive must deny, never fall
 * back to the session owner, on EITHER tier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDriveFindFirst = vi.hoisted(() => vi.fn());
const mockDriveMemberFindFirst = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: mockDriveFindFirst },
      driveMembers: { findFirst: mockDriveMemberFindFirst },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...parts) => ({ op: 'and', parts })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'drives.id', ownerId: 'drives.ownerId' } }));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { id: 'driveMembers.id', driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', role: 'driveMembers.role', acceptedAt: 'driveMembers.acceptedAt' },
}));

const mockCanRunCode = vi.hoisted(() => vi.fn());
vi.mock('../../sandbox/can-run-code', () => ({ canRunCode: mockCanRunCode }));

import { resolveSessionTenantId, resolveDriveMembership, canRunCodeForSession } from '../agent-workspace-tenant';

beforeEach(() => {
  mockDriveFindFirst.mockReset();
  mockDriveMemberFindFirst.mockReset();
  mockCanRunCode.mockReset();
});

describe('resolveSessionTenantId', () => {
  it('given a global-assistant session (no drive), should resolve the session owner without a DB read', async () => {
    const result = await resolveSessionTenantId({ driveId: null, ownerId: 'owner-1' });
    expect(result).toEqual({ ok: true, tenantId: 'owner-1' });
    expect(mockDriveFindFirst).not.toHaveBeenCalled();
  });

  it('given a drive-scoped session whose drive exists, should resolve the DRIVE owner', async () => {
    mockDriveFindFirst.mockResolvedValue({ ownerId: 'drive-owner-1' });
    const result = await resolveSessionTenantId({ driveId: 'drive-1', ownerId: 'owner-1' });
    expect(result).toEqual({ ok: true, tenantId: 'drive-owner-1' });
  });

  it('given a VANISHED drive, should fail CLOSED — never fall back to the session owner', async () => {
    mockDriveFindFirst.mockResolvedValue(undefined);
    const result = await resolveSessionTenantId({ driveId: 'gone-drive', ownerId: 'owner-1' });
    expect(result).toEqual({ ok: false, reason: 'drive_not_found' });
  });
});

describe('resolveDriveMembership', () => {
  it('given a vanished drive, should answer none', async () => {
    mockDriveFindFirst.mockResolvedValue(undefined);
    const result = await resolveDriveMembership({ userId: 'user-1', driveId: 'gone-drive' });
    expect(result).toBe('none');
    expect(mockDriveMemberFindFirst).not.toHaveBeenCalled();
  });

  it('given the requester IS the drive owner, should answer owner without a membership read', async () => {
    mockDriveFindFirst.mockResolvedValue({ ownerId: 'user-1' });
    const result = await resolveDriveMembership({ userId: 'user-1', driveId: 'drive-1' });
    expect(result).toBe('owner');
    expect(mockDriveMemberFindFirst).not.toHaveBeenCalled();
  });

  it('given an accepted MEMBER who is not the owner, should answer member', async () => {
    mockDriveFindFirst.mockResolvedValue({ ownerId: 'someone-else' });
    mockDriveMemberFindFirst.mockResolvedValue({ role: 'MEMBER' });
    const result = await resolveDriveMembership({ userId: 'user-1', driveId: 'drive-1' });
    expect(result).toBe('member');
  });

  it('given an accepted ADMIN, should answer admin — the END decision needs delete authority (codex round 12)', async () => {
    mockDriveFindFirst.mockResolvedValue({ ownerId: 'someone-else' });
    mockDriveMemberFindFirst.mockResolvedValue({ role: 'ADMIN' });
    const result = await resolveDriveMembership({ userId: 'user-1', driveId: 'drive-1' });
    expect(result).toBe('admin');
  });

  it('given no accepted membership row, should answer none', async () => {
    mockDriveFindFirst.mockResolvedValue({ ownerId: 'someone-else' });
    mockDriveMemberFindFirst.mockResolvedValue(undefined);
    const result = await resolveDriveMembership({ userId: 'user-1', driveId: 'drive-1' });
    expect(result).toBe('none');
  });
});

describe('canRunCodeForSession', () => {
  it('given a drive-scoped session, should pass the driveId and ownerId through as-is', async () => {
    mockCanRunCode.mockResolvedValue({ ok: true });
    await canRunCodeForSession({ userId: 'user-1', driveId: 'drive-1', ownerId: 'owner-1' });
    expect(mockCanRunCode).toHaveBeenCalledWith({
      userId: 'user-1',
      driveId: 'drive-1',
      ownerId: 'owner-1',
      requestOrigin: 'user',
    });
  });

  it('given a global-assistant session (null driveId), should pass undefined, not null', async () => {
    mockCanRunCode.mockResolvedValue({ ok: true });
    await canRunCodeForSession({ userId: 'user-1', driveId: null, ownerId: 'owner-1' });
    expect(mockCanRunCode).toHaveBeenCalledWith({
      userId: 'user-1',
      driveId: undefined,
      ownerId: 'owner-1',
      requestOrigin: 'user',
    });
  });

  it('given the capability check refuses, should reduce to false', async () => {
    mockCanRunCode.mockResolvedValue({ ok: false, reason: 'kill_switch_off' });
    const result = await canRunCodeForSession({ userId: 'user-1', driveId: 'drive-1', ownerId: 'owner-1' });
    expect(result).toBe(false);
  });
});
