import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveAgentMembers: {
    id: 'id',
    agentPageId: 'agentPageId',
    driveId: 'driveId',
    role: 'role',
    customRoleId: 'customRoleId',
  },
  driveRoles: {
    id: 'id',
    permissions: 'permissions',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getAgentAccessLevel, hasAgentDriveMembership } from '../agent-permissions';
import { db } from '@pagespace/db/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_PAGE_ID = 'agent_aaaaaaaaaaaaaaaaaaaaaa';
const TARGET_PAGE_ID = 'page_bbbbbbbbbbbbbbbbbbbbbbb';
const DRIVE_ID = 'drive_cccccccccccccccccccccc';
const CUSTOM_ROLE_ID = 'role_dddddddddddddddddddddd';

function stubSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

// ---------------------------------------------------------------------------
// getAgentAccessLevel — existing page-level behaviour
// ---------------------------------------------------------------------------

describe('getAgentAccessLevel — page targets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when agent has no membership in the drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))   // page lookup
      .mockReturnValueOnce(stubSelect([]));                         // membership lookup

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, TARGET_PAGE_ID);
    expect(result).toBeNull();
  });

  it('returns full access for ADMIN role agent', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, TARGET_PAGE_ID);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('returns view-only for MEMBER agent with no custom role', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, TARGET_PAGE_ID);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('returns custom role permissions for MEMBER agent with custom role', async () => {
    const perms = { [TARGET_PAGE_ID]: { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, TARGET_PAGE_ID);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });
});

// ---------------------------------------------------------------------------
// getAgentAccessLevel — drive-as-root-node
// ---------------------------------------------------------------------------

describe('getAgentAccessLevel — drive targets (drive-as-root-node)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when agent has no membership in the drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))   // page lookup → not a page
      .mockReturnValueOnce(stubSelect([]));  // membership lookup → none

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, DRIVE_ID);
    expect(result).toBeNull();
  });

  it('returns full access for ADMIN role agent on a drive ID', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))                                        // page lookup → not a page
      .mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }])); // membership

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, DRIVE_ID);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('returns view-only for MEMBER agent with no custom role on a drive ID', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, DRIVE_ID);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('returns canEdit: true when MEMBER agent custom role grants drive-level canEdit', async () => {
    const perms = { [DRIVE_ID]: { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, DRIVE_ID);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });

  it('returns canEdit: false when MEMBER agent custom role denies drive-level canEdit', async () => {
    const perms = { [DRIVE_ID]: { canView: true, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, DRIVE_ID);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('returns all-false when MEMBER agent custom role has no drive-level entry', async () => {
    const perms = { 'some-other-page': { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms }]));

    const result = await getAgentAccessLevel(AGENT_PAGE_ID, DRIVE_ID);
    expect(result).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
  });
});

// ---------------------------------------------------------------------------
// hasAgentDriveMembership
// ---------------------------------------------------------------------------

describe('hasAgentDriveMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when membership row exists', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: 'member-1' }]));
    expect(await hasAgentDriveMembership(AGENT_PAGE_ID, DRIVE_ID)).toBe(true);
  });

  it('returns false when no membership row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    expect(await hasAgentDriveMembership(AGENT_PAGE_ID, DRIVE_ID)).toBe(false);
  });
});
