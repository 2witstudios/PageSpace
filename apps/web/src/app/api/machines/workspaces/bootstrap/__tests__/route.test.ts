/**
 * Contract tests for POST /api/machines/workspaces/bootstrap
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockBuildMachineWorkspacesDeps,
  mockToWorkspaceDTO,
  mockBootstrapWorkspaces,
  mockBroadcastMachineWorkspaceEvent,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockBuildMachineWorkspacesDeps: vi.fn(),
  mockToWorkspaceDTO: vi.fn(),
  mockBootstrapWorkspaces: vi.fn(),
  mockBroadcastMachineWorkspaceEvent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/machines/machine-workspaces-runtime', () => ({
  buildMachineWorkspacesDeps: (...args: unknown[]) => mockBuildMachineWorkspacesDeps(...args),
  canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  toWorkspaceDTO: (...args: unknown[]) => mockToWorkspaceDTO(...args),
}));

vi.mock('@pagespace/lib/services/machines/machine-workspaces', () => ({
  bootstrapWorkspaces: (...args: unknown[]) => mockBootstrapWorkspaces(...args),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastMachineWorkspaceEvent: (...args: unknown[]) => mockBroadcastMachineWorkspaceEvent(...args),
}));

import { POST } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };
const FAKE_DEPS = { store: {} } as never;

const SAMPLE_RECORD = {
  id: 'ws-1',
  name: 'Workspace 1',
  scope: 'machine' as const,
  projectName: null,
  branchName: null,
  layout: { columns: [] },
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ownerId: 'user-1',
  machineId: 't1',
};

function req(body: unknown) {
  return new Request('https://x.test/api/machines/workspaces/bootstrap', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockBuildMachineWorkspacesDeps.mockReturnValue(FAKE_DEPS);
  mockToWorkspaceDTO.mockImplementation((record: typeof SAMPLE_RECORD) => ({ id: record.id, name: record.name }));
});

describe('POST /api/machines/workspaces/bootstrap', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await POST(req({ machineId: 't1', workspaces: [] }));
    expect(res.status).toBe(401);
  });

  it('given a malformed workspaces array, returns 400', async () => {
    const res = await POST(req({ machineId: 't1', workspaces: [{ name: 'no id' }] }));
    expect(res.status).toBe(400);
    expect(mockBootstrapWorkspaces).not.toHaveBeenCalled();
  });

  it('given no edit access, returns 403 without bootstrapping', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ machineId: 't1', workspaces: [] }));
    expect(res.status).toBe(403);
    expect(mockBootstrapWorkspaces).not.toHaveBeenCalled();
  });

  it('given the FIRST caller for a machine, claims, returns claimed:true, and broadcasts bootstrapped', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockBootstrapWorkspaces.mockResolvedValue({ ok: true, claimed: true, workspaces: [SAMPLE_RECORD] });
    const res = await POST(
      req({ machineId: 't1', workspaces: [{ id: 'ws-1', name: 'Workspace 1', scope: {}, columns: [] }] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(mockBroadcastMachineWorkspaceEvent).toHaveBeenCalledWith(
      't1',
      'machine-workspace:bootstrapped',
      expect.objectContaining({ machineId: 't1' }),
    );
  });

  it('given a caller that LOSES the claim race, returns claimed:false with the winner\'s list, and does NOT broadcast', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockBootstrapWorkspaces.mockResolvedValue({ ok: true, claimed: false, workspaces: [SAMPLE_RECORD] });
    const res = await POST(
      req({ machineId: 't1', workspaces: [{ id: 'ws-2', name: "loser's workspace", scope: {}, columns: [] }] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(false);
    expect(body.workspaces).toEqual([{ id: 'ws-1', name: 'Workspace 1' }]);
    expect(mockBroadcastMachineWorkspaceEvent).not.toHaveBeenCalled();
  });

  it('given an invalid entry\'s denial reason, maps it to 400', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockBootstrapWorkspaces.mockResolvedValue({ ok: false, reason: 'invalid_name' });
    const res = await POST(
      req({ machineId: 't1', workspaces: [{ id: 'ws-1', name: '   ', scope: {}, columns: [] }] }),
    );
    expect(res.status).toBe(400);
  });

  it('given no machineId, returns 400', async () => {
    const res = await POST(req({ workspaces: [] }));
    expect(res.status).toBe(400);
  });
});
