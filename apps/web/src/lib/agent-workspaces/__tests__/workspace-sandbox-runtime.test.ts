/**
 * `resolveSessionSandboxHandle` — the code-execution gate on the browse surface.
 *
 * `decideAgentSessionAccess` is deliberately capability-free: the session
 * SURFACE (list, detail, panes) is free to any drive member, and every
 * chokepoint that SPENDS COMPUTE consults `canRunCode` for itself. This
 * resolver is such a chokepoint — the files, diff and git-blob routes read and
 * WRITE through the handle it returns, and they gate on `checkSessionAccess`
 * alone — and it was missing from that list.
 *
 * The gap was narrow while the handle could only be a session's own ephemeral
 * sandbox. It stopped being narrow when an env-bound session began resolving
 * the ENVIRONMENT's machine: that disk is shared by every session in the drive
 * and outlives all of them, so an ungated write is a write into other people's
 * working tree by someone the drive never granted compute to.
 *
 * These tests pin the gate and the ORDER it runs in, because the order is what
 * keeps the denial from being an oracle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindSessionRecord = vi.fn();
const mockCanRunCodeForSession = vi.fn();
const mockAttach = vi.fn();
const mockResolveLiveSandboxId = vi.fn();

vi.mock('../agent-workspaces-runtime', () => ({
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
  getSandboxHost: async () => ({ attach: (...args: unknown[]) => mockAttach(...args) }),
  resolveSessionLiveSandboxId: (...args: unknown[]) => mockResolveLiveSandboxId(...args),
}));
// The SHARED capability helper — the same one the session GET calls to compute
// `sandboxEligible`, which is the point: the gate and the field the UI renders
// from must not be able to disagree.
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-tenant', () => ({
  canRunCodeForSession: (...args: unknown[]) => mockCanRunCodeForSession(...args),
}));
vi.mock('@pagespace/db/db', () => ({ db: { query: { users: { findFirst: vi.fn() } } } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));

const { resolveSessionSandboxHandle } = await import('../workspace-sandbox-runtime');

const REQUESTER = 'user-requester';
const WORKSPACE = 'ses-1';

/** An env-bound session: its own Sprite columns are CHECK-forbidden to hold anything. */
const envSession = {
  id: WORKSPACE,
  ownerId: 'user-owner',
  driveId: 'drive-1',
  envId: 'env-1',
  sandboxId: null,
  spriteTornDownAt: null,
  endedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindSessionRecord.mockResolvedValue(envSession);
  mockCanRunCodeForSession.mockResolvedValue(true);
  mockResolveLiveSandboxId.mockResolvedValue('pgs-env-abc');
  mockAttach.mockResolvedValue({ sandboxId: 'pgs-env-abc' });
});

describe('resolveSessionSandboxHandle — the capability gate', () => {
  it('given a requester who may not run code, should refuse — never hand back the environment', async () => {
    // The drive gate said yes (they are a member); the CAPABILITY gate says no.
    // Without this the files route's POST/PATCH/DELETE would write into a
    // drive-wide disk on behalf of someone with a view-only role.
    mockCanRunCodeForSession.mockResolvedValue(false);

    expect(await resolveSessionSandboxHandle(WORKSPACE, REQUESTER)).toEqual({
      ok: false,
      reason: 'not_authorized',
    });
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it('should ask the gate with the SESSION\'s drive and owner, as the provisioner does', async () => {
    // Browsing a sandbox and provisioning one must not disagree about who is
    // allowed to — so the arguments match `provisionSessionSandbox`'s exactly.
    await resolveSessionSandboxHandle(WORKSPACE, REQUESTER);

    // Same shape `sandboxEligible` is computed from, so a requester the UI shows
    // disabled controls to is exactly the requester this refuses.
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({
      userId: REQUESTER,
      driveId: 'drive-1',
      ownerId: 'user-owner',
    });
  });

  it('should run the gate BEFORE resolving which machine exists', async () => {
    // Order is what stops the denial being an oracle: a refused requester must
    // not be able to tell a session with a live environment from one without.
    mockCanRunCodeForSession.mockResolvedValue(false);

    await resolveSessionSandboxHandle(WORKSPACE, REQUESTER);

    expect(mockResolveLiveSandboxId).not.toHaveBeenCalled();
  });

  it('given a vanished session, should answer not_found without consulting the gate', async () => {
    mockFindSessionRecord.mockResolvedValue(null);

    expect(await resolveSessionSandboxHandle(WORKSPACE, REQUESTER)).toEqual({ ok: false, reason: 'not_found' });
    expect(mockCanRunCodeForSession).not.toHaveBeenCalled();
  });

  it('given an ENDED session, should refuse even with the capability', async () => {
    // Ending an env session kills no machine, so the environment is still
    // running — the refusal has to be explicit or the files routes keep
    // mutating a shared disk under a session the API reports as finished.
    mockFindSessionRecord.mockResolvedValue({ ...envSession, endedAt: new Date() });

    expect(await resolveSessionSandboxHandle(WORKSPACE, REQUESTER)).toEqual({ ok: false, reason: 'not_started' });
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it('given a permitted requester and a live environment, should hand back the handle', async () => {
    const result = await resolveSessionSandboxHandle(WORKSPACE, REQUESTER);

    expect(result.ok).toBe(true);
    expect(mockAttach).toHaveBeenCalledWith({ sandboxId: 'pgs-env-abc' });
  });

  it('given no machine yet, should answer not_started rather than attaching to nothing', async () => {
    mockResolveLiveSandboxId.mockResolvedValue(null);

    expect(await resolveSessionSandboxHandle(WORKSPACE, REQUESTER)).toEqual({ ok: false, reason: 'not_started' });
    expect(mockAttach).not.toHaveBeenCalled();
  });
});
