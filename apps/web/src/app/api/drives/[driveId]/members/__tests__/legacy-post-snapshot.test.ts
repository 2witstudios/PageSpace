/**
 * @scaffold - characterizing master-baseline behavior of the legacy POST
 * /api/drives/[driveId]/members handler while it is being refactored to use
 * the driveInviteRepository seam (Epic 2).
 *
 * Slated for removal in Epic 4 when the legacy POST is retired in favor of
 * /api/drives/[driveId]/members/invite.
 *
 * The frozen baseline at __fixtures__/legacy-post-baseline.json was captured
 * directly from the master implementation BEFORE the refactor. Drift in
 * status, body shape, or audit/activity payload would mean a silent behavior
 * change — exactly what this scaffold exists to catch.
 */

import { describe, expect, vi, beforeEach, beforeAll, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findDriveById: vi.fn(),
    findExistingMember: vi.fn(),
    createDriveMember: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: {
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logMemberActivity: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { logMemberActivity, getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const mockUserId = 'user_123';
const mockDriveId = 'drive_abc';
const mockInvitedUserId = 'user_456';
const fixedDate = new Date('2025-01-15T12:00:00.000Z');

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_test',
  role: 'user',
  adminRoleVersion: 0,
});

const authErr = (status: number): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const driveFixture = {
  id: mockDriveId,
  name: 'Test Drive',
  slug: 'test-drive',
  ownerId: mockUserId,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
};

const memberFixture = (role: 'MEMBER' | 'ADMIN' = 'MEMBER') => ({
  id: 'mem_new',
  driveId: mockDriveId,
  userId: mockInvitedUserId,
  role,
  customRoleId: null,
  invitedBy: mockUserId,
  invitedAt: fixedDate,
  acceptedAt: fixedDate,
  lastAccessedAt: null,
});

const ctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
const buildRequest = (body: unknown) =>
  new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

interface BaselineCase {
  status: number;
  body: unknown;
  audit?: { eventType: string; resourceType: string; details: Record<string, unknown> } | null;
  activity?: { action: string; payload: Record<string, unknown> } | null;
}

let baseline: Record<string, BaselineCase>;

beforeAll(() => {
  baseline = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'legacy-post-baseline.json'), 'utf-8')
  ) as Record<string, BaselineCase>;
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(mockUserId));
  vi.mocked(isAuthError).mockReturnValue(false);
  vi.mocked(getActorInfo).mockResolvedValue({
    actorEmail: 'owner@example.com',
    actorDisplayName: 'Owner',
  });
});

const assertMatches = async (key: string, response: Response) => {
  const expected = baseline[key];
  expect(response.status, key).toBe(expected.status);
  expect(await response.json(), key).toEqual(expected.body);
  return expected;
};

describe('Legacy POST /api/drives/[driveId]/members — frozen baseline', () => {
  test('case=unauthenticated → 401, no audit, no activity', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authErr(401));

    await assertMatches(
      'unauthenticated',
      await POST(buildRequest({ userId: mockInvitedUserId }), ctx(mockDriveId))
    );
    expect(auditRequest).not.toHaveBeenCalled();
    expect(logMemberActivity).not.toHaveBeenCalled();
  });

  test('case=missing_drive → 404, no side effects', async () => {
    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(null);

    await assertMatches(
      'missing_drive',
      await POST(buildRequest({ userId: mockInvitedUserId }), ctx(mockDriveId))
    );
    expect(auditRequest).not.toHaveBeenCalled();
    expect(logMemberActivity).not.toHaveBeenCalled();
  });

  test.each([
    ['non_owner_admin_blocked'],
    ['non_owner_member_blocked'],
  ])('case=%s → 403, no side effects', async (key) => {
    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
      ...driveFixture,
      ownerId: 'someone_else',
    });

    await assertMatches(
      key,
      await POST(buildRequest({ userId: mockInvitedUserId }), ctx(mockDriveId))
    );
    expect(auditRequest).not.toHaveBeenCalled();
    expect(logMemberActivity).not.toHaveBeenCalled();
  });

  test('case=already_member → 400, no side effects', async () => {
    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(driveFixture);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(memberFixture());

    await assertMatches(
      'already_member',
      await POST(buildRequest({ userId: mockInvitedUserId }), ctx(mockDriveId))
    );
    expect(auditRequest).not.toHaveBeenCalled();
    expect(logMemberActivity).not.toHaveBeenCalled();
  });

  test.each([
    ['success_default_role', undefined, 'MEMBER' as const],
    ['success_admin_role', 'ADMIN' as const, 'ADMIN' as const],
  ])(
    'case=%s → 200, audit + activity emitted with byte-identical payloads',
    async (key, role, expectedRole) => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(driveFixture);
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue(
        memberFixture(expectedRole)
      );

      const expected = await assertMatches(
        key,
        await POST(
          buildRequest(role ? { userId: mockInvitedUserId, role } : { userId: mockInvitedUserId }),
          ctx(mockDriveId)
        )
      );

      expect(auditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: expected.audit!.eventType,
          resourceType: expected.audit!.resourceType,
          details: expected.audit!.details,
        })
      );
      expect(logMemberActivity).toHaveBeenCalledWith(
        mockUserId,
        expected.activity!.action,
        expect.objectContaining(expected.activity!.payload),
        expect.anything()
      );
    }
  );
});
