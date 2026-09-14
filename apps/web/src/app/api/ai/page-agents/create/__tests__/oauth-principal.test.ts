/**
 * Phase 2 cluster test — agent configuration (inline scope branches).
 *
 * Creating an agent makes two inline drive-scope decisions: a root-level agent
 * needs the credential's OWN role to be OWNER, and a drive-scoped credential
 * may not enable an account-level-only tool (`create_drive`). Written against
 * `isScopedMCPAuth`, an OAuth grant skipped both and created with the owning
 * user's powers. Real scope/principal helpers; repository stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/page-agent-repository', () => ({
  pageAgentRepository: { getDriveById: vi.fn(), getParentPage: vi.fn() },
}));
vi.mock('@/lib/websocket', () => ({ broadcastPageEvent: vi.fn(), createPageEventPayload: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const named = { ...child, child: vi.fn(() => child) };
  return {
    loggers: new Proxy({}, { get: () => named }),
    logger: named,
    logSecurityEvent: vi.fn(),
  };
});
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>();
  return {
    ...actual,
    ...(await import('@/lib/auth/__tests__/oauth-principal-fixture')).stillMemberScopedResolvers(),
    getAppDriveMembership: vi.fn(),
  };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { pageAgentRepository } from '@/lib/repositories/page-agent-repository';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';

const create = (driveId: string, enabledTools?: string[]) =>
  POST(
    new Request('https://example.com/api/ai/page-agents/create', {
      method: 'POST',
      body: JSON.stringify({ driveId, title: 'Agent', systemPrompt: 'Be useful', ...(enabledTools ? { enabledTools } : {}) }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  // The owning user owns every drive, so every refusal is the grant's narrowing.
  vi.mocked(pageAgentRepository.getDriveById).mockImplementation((async (driveId: string) => ({ id: driveId, ownerId: PARITY_USER_ID })) as never);
});

describe('POST /api/ai/page-agents/create — OAuth principals', () => {
  it('refuses a root-level agent under a drive:X:admin grant although the user owns X', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    const res = await create(DRIVE_X);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only drive owners can create agents at the root level' });
  });

  it('is the same refusal an ADMIN-role mcp_ key gets (parity)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey(DRIVE_X));
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: PARITY_USER_ID });
    const res = await create(DRIVE_X);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only drive owners can create agents at the root level' });
  });

  it('refuses an account-level-only tool to an inherit grant that cleared the root gate', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'inherit'));
    const res = await create(DRIVE_X, ['create_drive']);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Invalid tools specified: create_drive');
  });

  it('refuses the grant in drive Y', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'inherit'));
    const res = await create(DRIVE_Y);
    expect(res.status).toBe(403);
  });

  it('refuses a profile-only token in every drive', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(profileOnlyGrant());
    for (const driveId of [DRIVE_X, DRIVE_Y]) {
      const res = await create(driveId);
      expect(res.status).toBe(403);
    }
  });
});
