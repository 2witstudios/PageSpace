// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDrivesFindFirst, mockUsersFindFirst, mockGetActorInfo, mockGate, mockRunBash, mockBuildRunDeps } = vi.hoisted(() => ({
  mockDrivesFindFirst: vi.fn(),
  mockUsersFindFirst: vi.fn(),
  mockGetActorInfo: vi.fn(),
  mockGate: vi.fn(),
  mockRunBash: vi.fn(),
  mockBuildRunDeps: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { query: { drives: { findFirst: mockDrivesFindFirst }, users: { findFirst: mockUsersFindFirst } } },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: (column: unknown, value: unknown) => ({ column, value }) }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'id' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: mockGetActorInfo }));
vi.mock('@pagespace/lib/billing/subscription-tiers', () => ({
  toSubscriptionTier: (tier: string | null | undefined) => tier ?? 'free',
}));
vi.mock('@pagespace/lib/services/sandbox/tool-runners', () => ({ runBashInSandbox: mockRunBash }));
vi.mock('@/lib/ai/tools/sandbox-tools-runtime', () => ({
  buildRealSandboxRunDeps: mockBuildRunDeps,
  productionSandboxGate: mockGate,
}));

import { execInWorkspace, resolveWorkspaceExecActorContext } from '../workspace-exec-runtime';

const DRIVE_SESSION = { id: 'ws-1', ownerId: 'session-owner', driveId: 'drive-1', endedAt: null } as never;
const GLOBAL_SESSION = { id: 'ws-2', ownerId: 'session-owner', driveId: null, endedAt: null } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActorInfo.mockResolvedValue({ actorEmail: 'actor@example.com', actorDisplayName: 'Actor' });
  mockDrivesFindFirst.mockResolvedValue({ ownerId: 'drive-owner' });
  mockUsersFindFirst.mockResolvedValue({ subscriptionTier: 'pro' });
  mockGate.mockResolvedValue({ ok: true });
  mockBuildRunDeps.mockReturnValue({ deps: true });
  mockRunBash.mockResolvedValue({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
});

describe('resolveWorkspaceExecActorContext', () => {
  it('given a drive workspace, should bill and tier against the DRIVE OWNER, act as the caller', async () => {
    const ctx = await resolveWorkspaceExecActorContext(DRIVE_SESSION, 'caller');
    expect(ctx).toEqual({
      userId: 'caller',
      tenantId: 'drive-owner',
      driveId: 'drive-1',
      ownerId: 'session-owner',
      conversationId: 'workspace-exec:ws-1',
      requestOrigin: 'user',
      actorEmail: 'actor@example.com',
      actorDisplayName: 'Actor',
      tier: 'pro',
    });
    // The PAYER's tier: the drive owner's row, never the acting caller's.
    expect(mockUsersFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { column: 'id', value: 'drive-owner' } }));
  });

  it('given a driveless workspace, should use the session owner as tenant and payer, with no driveId', async () => {
    const ctx = await resolveWorkspaceExecActorContext(GLOBAL_SESSION, 'caller');
    expect(ctx).toMatchObject({ tenantId: 'session-owner', ownerId: 'session-owner' });
    expect(ctx).not.toHaveProperty('driveId');
    expect(mockDrivesFindFirst).not.toHaveBeenCalled();
    expect(mockUsersFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { column: 'id', value: 'session-owner' } }));
  });

  it('given a drive that no longer exists, should refuse', async () => {
    mockDrivesFindFirst.mockResolvedValue(undefined);
    expect(await resolveWorkspaceExecActorContext(DRIVE_SESSION, 'caller')).toEqual({
      error: 'Code execution requires an active drive.',
    });
  });
});

describe('execInWorkspace', () => {
  const ctx = { userId: 'caller', tenantId: 'drive-owner', conversationId: 'workspace-exec:ws-1' } as never;

  it('given a gate denial, should answer it and NEVER reach the runner', async () => {
    mockGate.mockResolvedValue({ ok: false, reason: 'tier_ineligible', error: 'Pro plan', retryAfter: 5 });
    const result = await execInWorkspace({ session: DRIVE_SESSION, ctx, command: 'ls' });
    expect(result).toEqual({ success: false, error: 'Pro plan', reason: 'tier_ineligible', retryAfter: 5 });
    expect(mockRunBash).not.toHaveBeenCalled();
  });

  it('given an allowed call, should run through deps whose session resolver answers the ROUTE-AUTHORIZED row', async () => {
    const result = await execInWorkspace({ session: DRIVE_SESSION, ctx, command: 'ls', cwd: 'repo', timeoutMs: 9 });
    expect(result).toEqual({ success: true, stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
    expect(mockRunBash).toHaveBeenCalledWith({ command: 'ls', cwd: 'repo', timeoutMs: 9, ctx, deps: { deps: true } });

    const [{ resolveSession }] = mockBuildRunDeps.mock.calls[0];
    expect(await resolveSession('any-conversation', 'any-user')).toEqual({ ok: true, session: DRIVE_SESSION });
  });
});
