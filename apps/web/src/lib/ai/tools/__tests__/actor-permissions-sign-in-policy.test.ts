import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCheckResource, mockCheckDrive, mockCanUserEditPage, mockGetUserAccessLevel, mockGetAgentAccessLevel, mockDbWhere } = vi.hoisted(() => ({
  mockCheckResource: vi.fn(),
  mockCheckDrive: vi.fn(),
  mockCanUserEditPage: vi.fn(),
  mockGetUserAccessLevel: vi.fn(),
  mockGetAgentAccessLevel: vi.fn(),
  mockDbWhere: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/actor-authentication', () => ({
  checkActorResourceAuthentication: mockCheckResource,
  checkActorDriveAuthentication: mockCheckDrive,
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  explainSignInRefusal: vi.fn().mockResolvedValue(null),
  getUserAccessLevel: mockGetUserAccessLevel,
  getUserDriveAccess: vi.fn(),
  canUserEditPage: mockCanUserEditPage,
  canUserDeletePage: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/agent-permissions', () => ({
  getAgentAccessLevel: mockGetAgentAccessLevel,
  getAgentAccessiblePagesInDrive: vi.fn(),
  hasAgentDriveMembership: vi.fn(),
  hasAgentDriveAdminRole: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppAccessLevel: vi.fn(),
  getAppDriveMembership: vi.fn(),
  getAppDriveAccessLevel: vi.fn(),
  getAppAccessiblePagesInDrive: vi.fn(),
  hasAppDriveMembership: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({ checkDriveAccess: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: mockDbWhere }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', userScopedAccess: 'userScopedAccess', parentId: 'parentId' },
}));

import { canActorEditPage, canActorViewPage } from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const ORG_PAGE = 'page-in-org-drive';
const AGENT_PAGE = 'agent-page-1';
const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
// A magic-link session signed in an hour ago: an org requiring strong sign-in refuses it.
const weakCredential = credentialActor('user-1', { authenticatedAtMs: Date.now() - 3_600_000, assurance: 'single_factor' });

const userContext = { userId: 'user-1', accessActor: weakCredential } as ToolExecutionContext;
// A global chat that consults a page agent: the agent's own drive memberships would reach the org page.
const agentContext = {
  userId: 'user-1',
  accessActor: weakCredential,
  chatSource: { type: 'page', agentPageId: AGENT_PAGE },
} as ToolExecutionContext;

describe('SEC-2 (partial) a tool call driven by a credential its org refuses cannot view or edit that org\'s page, even through an agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckResource.mockResolvedValue({ allowed: false, code: 'org_strong_sign_in_required' });
    mockCheckDrive.mockResolvedValue({ allowed: false, code: 'org_strong_sign_in_required' });
    // Every grant underneath would admit the call: only the sign-in policy can be what refuses it.
    mockGetUserAccessLevel.mockResolvedValue(FULL);
    mockCanUserEditPage.mockResolvedValue(true);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);
    // The acting page is a real agent without user-scoped reach.
    mockDbWhere.mockResolvedValue([{ type: 'AI_CHAT', userScopedAccess: false, parentId: null }]);
  });

  it('refuses a read the driver\'s own grants would allow, asking the policy of the driver\'s credential', async () => {
    expect(await canActorViewPage(userContext, ORG_PAGE)).toBe(false);
    expect(mockCheckResource).toHaveBeenCalledWith(weakCredential, ORG_PAGE);
    expect(mockGetUserAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a write the driver\'s own grants would allow', async () => {
    expect(await canActorEditPage(userContext, ORG_PAGE)).toBe(false);
    expect(mockCanUserEditPage).not.toHaveBeenCalled();
  });

  it('refuses a page agent\'s read and write too: an agent widens reach, never which org rule the driver must meet', async () => {
    expect(await canActorViewPage(agentContext, ORG_PAGE)).toBe(false);
    expect(await canActorEditPage(agentContext, ORG_PAGE)).toBe(false);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('a passkey credential the org admits for the same user gets in through the same grants', async () => {
    mockCheckResource.mockResolvedValue({ allowed: true });
    const strong = credentialActor('user-1', { authenticatedAtMs: Date.now() - 60_000, assurance: 'user_verified_passkey' });

    expect(await canActorViewPage({ userId: 'user-1', accessActor: strong } as ToolExecutionContext, ORG_PAGE)).toBe(true);
    expect(await canActorEditPage({ ...agentContext, accessActor: strong }, ORG_PAGE)).toBe(true);
  });

  it('a context whose actor names a different user refuses rather than guessing who is asking', async () => {
    mockCheckResource.mockResolvedValue({ allowed: true });
    await expect(canActorViewPage({ userId: 'user-2', accessActor: weakCredential } as ToolExecutionContext, ORG_PAGE)).rejects.toThrow();
  });
});
