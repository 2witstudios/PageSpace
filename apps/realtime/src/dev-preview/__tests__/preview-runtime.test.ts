/**
 * The realtime binding of the preview gather: every dep must reach the real
 * store/permission/sprite seams with the right arguments, and
 * `resolveHolderSandboxId` must read the HOLDER's own row (never a caller's
 * claim) through the same liveness rule the web tier uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sessionStore, envStore, dbSelect, attach } = vi.hoisted(() => ({
  sessionStore: { findById: vi.fn() },
  envStore: { findById: vi.fn() },
  dbSelect: { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn() },
  attach: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn(() => dbSelect) } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'drives.id', ownerId: 'drives.ownerId' } }));
vi.mock('@pagespace/lib/services/sandbox/can-run-code', () => ({ canRunCode: vi.fn(async () => ({ ok: true })) }));
vi.mock('@pagespace/lib/services/sandbox/machine-session-manager', () => ({ getSandboxSessionSecret: () => 's'.repeat(40) }));
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-tenant', () => ({ resolveDriveMembership: vi.fn(async () => 'member') }));
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspaces-store', () => ({ createDbAgentSessionStore: async () => sessionStore }));
vi.mock('@pagespace/lib/services/drive-envs/drive-envs-store', () => ({ createDbDriveEnvStore: async () => envStore }));
vi.mock('@pagespace/lib/services/sandbox/sandbox-client/sprites', () => ({
  createSpritesSandboxClient: vi.fn(() => ({})),
  createSpriteHandleCache: vi.fn((sdk: unknown) => sdk),
}));
vi.mock('@pagespace/lib/services/sandbox/sandbox-client/sprite-sandbox-host', () => ({ createSpriteSandboxHost: vi.fn(() => ({ attach })) }));
vi.mock('@pagespace/lib/services/sandbox/preview/dev-preview-store', () => ({ createDbDevPreviewStore: vi.fn(() => ({ findByHolder: vi.fn(), upsert: vi.fn() })) }));
vi.mock('../../terminal/realtime-sprites-client', () => ({ getRealtimeSpritesSdk: async () => ({ getSprite: vi.fn() }) }));

import { canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import { buildRealtimePreviewAccessDeps, createConnectScopedSandboxHost, getRealtimePreviewCookieKey, getRealtimePreviewStore, resolveHolderSandboxId } from '../preview-runtime';

const session = (over: Record<string, unknown> = {}) => ({ id: 'ws1', ownerId: 'o', driveId: 'd', envId: null, sandboxId: 'sbx-ws', spriteTornDownAt: null, endedAt: null, extra: 'ignored', ...over });
const env = (over: Record<string, unknown> = {}) => ({ id: 'env1', driveId: 'd', substrate: 'sprite', sandboxId: 'sbx-env', spriteTornDownAt: null, extra: 'ignored', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStore.findById.mockResolvedValue(session());
  envStore.findById.mockResolvedValue(env());
  dbSelect.limit.mockResolvedValue([{ ownerId: 'owner-1' }]);
});

describe('buildRealtimePreviewAccessDeps', () => {
  it('projects session and env rows to the gather slices, and answers null for missing rows', async () => {
    const deps = buildRealtimePreviewAccessDeps();
    expect(await deps.findSession('ws1')).toEqual({ id: 'ws1', ownerId: 'o', driveId: 'd', envId: null, sandboxId: 'sbx-ws', spriteTornDownAt: null, endedAt: null });
    expect(await deps.findEnv('env1')).toEqual({ id: 'env1', driveId: 'd', substrate: 'sprite', sandboxId: 'sbx-env', spriteTornDownAt: null });
    sessionStore.findById.mockResolvedValueOnce(null);
    envStore.findById.mockResolvedValueOnce(null);
    expect(await deps.findSession('x')).toBeNull();
    expect(await deps.findEnv('x')).toBeNull();
  });

  it('resolves the drive payer from the drives table and fails closed on a vanished drive', async () => {
    const deps = buildRealtimePreviewAccessDeps();
    expect(await deps.resolveDrivePayer('d')).toEqual({ payerId: 'owner-1' });
    dbSelect.limit.mockResolvedValueOnce([]);
    expect(await deps.resolveDrivePayer('gone')).toBeNull();
  });

  it('asks the centralized code-execution gate as a user, mapping a null drive to undefined', async () => {
    const deps = buildRealtimePreviewAccessDeps();
    await deps.canRunCode({ userId: 'u', driveId: null, ownerId: 'o' });
    expect(canRunCode).toHaveBeenCalledWith({ userId: 'u', driveId: undefined, ownerId: 'o', requestOrigin: 'user' });
    await deps.canRunCode({ userId: 'u', driveId: 'd', ownerId: 'o' });
    expect(canRunCode).toHaveBeenLastCalledWith({ userId: 'u', driveId: 'd', ownerId: 'o', requestOrigin: 'user' });
  });

  it('attaches through a connect-scoped host and maps an attach failure to null', async () => {
    const deps = buildRealtimePreviewAccessDeps();
    attach.mockResolvedValueOnce({ sandboxId: 'sbx' });
    expect(await deps.attach('sbx')).toEqual({ sandboxId: 'sbx' });
    attach.mockRejectedValueOnce(new Error('gone'));
    expect(await deps.attach('sbx')).toBeNull();
    expect(await createConnectScopedSandboxHost()).toEqual({ attach });
  });

  it('exposes one store, a derived cookie key, the feature flag and a clock', async () => {
    const deps = buildRealtimePreviewAccessDeps();
    expect(getRealtimePreviewStore()).toBe(getRealtimePreviewStore());
    expect(deps.previewStore).toBe(getRealtimePreviewStore());
    expect(getRealtimePreviewCookieKey().length).toBe(32);
    expect(typeof deps.featureEnabled()).toBe('boolean');
    expect(deps.now()).toBeInstanceOf(Date);
  });
});

describe('resolveHolderSandboxId', () => {
  it('an env: its own live sprite; null when torn down, local, or missing', async () => {
    expect(await resolveHolderSandboxId({ kind: 'env', id: 'env1' })).toBe('sbx-env');
    envStore.findById.mockResolvedValueOnce(env({ spriteTornDownAt: new Date() }));
    expect(await resolveHolderSandboxId({ kind: 'env', id: 'env1' })).toBeNull();
    envStore.findById.mockResolvedValueOnce(env({ substrate: 'local', sandboxId: null }));
    expect(await resolveHolderSandboxId({ kind: 'env', id: 'env1' })).toBeNull();
    envStore.findById.mockResolvedValueOnce(null);
    expect(await resolveHolderSandboxId({ kind: 'env', id: 'env1' })).toBeNull();
  });

  it('a session: its own sprite, or its env\'s for an env-bound session; null when ended, missing, or the env vanished', async () => {
    expect(await resolveHolderSandboxId({ kind: 'workspace', id: 'ws1' })).toBe('sbx-ws');
    sessionStore.findById.mockResolvedValueOnce(session({ envId: 'env1', sandboxId: null }));
    expect(await resolveHolderSandboxId({ kind: 'workspace', id: 'ws1' })).toBe('sbx-env');
    sessionStore.findById.mockResolvedValueOnce(session({ endedAt: new Date() }));
    expect(await resolveHolderSandboxId({ kind: 'workspace', id: 'ws1' })).toBeNull();
    sessionStore.findById.mockResolvedValueOnce(null);
    expect(await resolveHolderSandboxId({ kind: 'workspace', id: 'ws1' })).toBeNull();
    sessionStore.findById.mockResolvedValueOnce(session({ envId: 'env1', sandboxId: null }));
    envStore.findById.mockResolvedValueOnce(null);
    expect(await resolveHolderSandboxId({ kind: 'workspace', id: 'ws1' })).toBeNull();
  });
});
