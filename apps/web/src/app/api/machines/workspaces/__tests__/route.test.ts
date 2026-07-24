/**
 * Contract tests for GET/POST/PATCH/DELETE /api/machines/workspaces
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockCanViewMachine,
  mockBuildMachineWorkspacesDeps,
  mockToWorkspaceDTO,
  mockCreateWorkspace,
  mockUpdateWorkspace,
  mockRemoveWorkspace,
  mockListWorkspaces,
  mockIsBootstrapped,
  mockBroadcastMachineWorkspaceEvent,
  mockAuditRequest,
  mockGetCurrentRev,
  mockSyncRelationalGrid,
  mockBroadcastLegacyGridSync,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockBuildMachineWorkspacesDeps: vi.fn(),
  mockToWorkspaceDTO: vi.fn(),
  mockCreateWorkspace: vi.fn(),
  mockUpdateWorkspace: vi.fn(),
  mockRemoveWorkspace: vi.fn(),
  mockListWorkspaces: vi.fn(),
  mockIsBootstrapped: vi.fn(),
  mockBroadcastMachineWorkspaceEvent: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockGetCurrentRev: vi.fn(),
  mockSyncRelationalGrid: vi.fn(),
  mockBroadcastLegacyGridSync: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

// `scopeFromBody`/`forbiddenMachineAccess`/`RESOURCE_TYPE`/`WORKSPACE_DENIAL_STATUS`
// are pure/shared helpers (no DB or sandbox I/O) — reused via `importOriginal`
// rather than re-implemented a third time here; only the DB/auth-backed pieces
// (deps, access checks, DTO mapping) are mocked.
vi.mock('@/lib/machines/machine-workspaces-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/machines/machine-workspaces-runtime')>();
  return {
    ...actual,
    buildMachineWorkspacesDeps: (...args: unknown[]) => mockBuildMachineWorkspacesDeps(...args),
    canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
    canViewMachine: (...args: unknown[]) => mockCanViewMachine(...args),
    toWorkspaceDTO: (...args: unknown[]) => mockToWorkspaceDTO(...args),
  };
});

vi.mock('@pagespace/lib/services/machines/machine-workspaces', () => ({
  createWorkspace: (...args: unknown[]) => mockCreateWorkspace(...args),
  updateWorkspace: (...args: unknown[]) => mockUpdateWorkspace(...args),
  removeWorkspace: (...args: unknown[]) => mockRemoveWorkspace(...args),
  listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
  isBootstrapped: (...args: unknown[]) => mockIsBootstrapped(...args),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastMachineWorkspaceEvent: (...args: unknown[]) => mockBroadcastMachineWorkspaceEvent(...args),
}));

// Rolling-deploy shim (#2202) — the relational sync side-effects of the
// legacy blob routes are DB-backed via `workspace-verbs-runtime.ts`'s lazy
// `machine-panes-store`; mocked here same as every other I/O dependency.
vi.mock('@/lib/machines/workspace-verbs-runtime', () => ({
  getCurrentRev: (...args: unknown[]) => mockGetCurrentRev(...args),
  syncRelationalGrid: (...args: unknown[]) => mockSyncRelationalGrid(...args),
  broadcastLegacyGridSync: (...args: unknown[]) => mockBroadcastLegacyGridSync(...args),
}));

import { GET, POST, PATCH, DELETE } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };
const FAKE_DEPS = { store: {} } as never;

const SAMPLE_RECORD = {
  id: 'ws-1',
  name: 'Workspace 1',
  scope: 'machine' as const,
  projectName: null,
  branchName: null,
  layout: { columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ownerId: 'user-1',
  machineId: 't1',
};

const SAMPLE_DTO = {
  id: 'ws-1',
  name: 'Workspace 1',
  scope: {},
  columns: SAMPLE_RECORD.layout.columns,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockBuildMachineWorkspacesDeps.mockReturnValue(FAKE_DEPS);
  mockToWorkspaceDTO.mockImplementation(() => SAMPLE_DTO);
  mockGetCurrentRev.mockResolvedValue(0);
  mockSyncRelationalGrid.mockResolvedValue({ rev: 1, applied: true });
});

describe('GET /api/machines/workspaces', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(new Request('https://x.test/api/machines/workspaces?machineId=t1'));
    expect(res.status).toBe(401);
  });

  it('given no machineId, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/workspaces'));
    expect(res.status).toBe(400);
  });

  it('given no view access, returns 403 without listing, and audits the denial', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/workspaces?machineId=t1'));
    expect(res.status).toBe(403);
    expect(mockListWorkspaces).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied', resourceId: 't1' }),
    );
  });

  it('given view access, lists workspaces and reports bootstrap status and rev', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListWorkspaces.mockResolvedValue([SAMPLE_RECORD]);
    mockIsBootstrapped.mockResolvedValue(true);
    mockGetCurrentRev.mockResolvedValue(7);
    const res = await GET(new Request('https://x.test/api/machines/workspaces?machineId=t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bootstrapped).toBe(true);
    expect(body.workspaces).toEqual([SAMPLE_DTO]);
    expect(body.rev).toBe(7);
    expect(mockListWorkspaces).toHaveBeenCalledWith(expect.objectContaining({ machineId: 't1' }));
  });
});

describe('POST /api/machines/workspaces', () => {
  function req(body: unknown) {
    return new Request('https://x.test/api/machines/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('given no edit access, returns 403 without creating', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ machineId: 't1', id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(403);
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('given a fresh create, returns 201, broadcasts machine-workspace:created, and audits data.write', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockCreateWorkspace.mockResolvedValue({ ok: true, created: true, workspace: SAMPLE_RECORD });
    const res = await POST(req({ machineId: 't1', id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(mockBroadcastMachineWorkspaceEvent).toHaveBeenCalledWith(
      't1',
      'machine-workspace:created',
      expect.objectContaining({ machineId: 't1', id: 'ws-1' }),
    );
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceId: 't1' }),
    );
    // Rolling-deploy shim: mirrors the create into the relational rows too.
    expect(mockSyncRelationalGrid).toHaveBeenCalledWith('t1', 'ws-1', SAMPLE_RECORD.layout.columns);
    expect(mockBroadcastLegacyGridSync).toHaveBeenCalledWith('t1', 'ws-1', 1, expect.objectContaining({ id: 'ws-1' }));
  });

  it('given an idempotent replay (already existed), returns 200 and does NOT re-broadcast, re-audit, or re-sync', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockCreateWorkspace.mockResolvedValue({ ok: true, created: false, workspace: SAMPLE_RECORD });
    const res = await POST(req({ machineId: 't1', id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(200);
    expect(mockBroadcastMachineWorkspaceEvent).not.toHaveBeenCalled();
    expect(mockSyncRelationalGrid).not.toHaveBeenCalled();
    expect(mockAuditRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write' }),
    );
  });

  it('given an invalid payload, maps the denial reason to 400', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockCreateWorkspace.mockResolvedValue({ ok: false, reason: 'invalid_columns' });
    const res = await POST(req({ machineId: 't1', id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(400);
  });

  it('given no machineId/id/name, returns 400 without checking access', async () => {
    const res = await POST(req({ id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/machines/workspaces', () => {
  function req(body: unknown) {
    return new Request('https://x.test/api/machines/workspaces', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('given neither name nor columns, returns 400 without checking access', async () => {
    const res = await PATCH(req({ machineId: 't1', workspaceId: 'ws-1' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given no edit access, returns 403 without updating', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await PATCH(req({ machineId: 't1', workspaceId: 'ws-1', name: 'Renamed' }));
    expect(res.status).toBe(403);
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  it('given a successful rename, returns 200, broadcasts only the changed field, and audits data.write', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockUpdateWorkspace.mockResolvedValue({ ok: true, workspace: { ...SAMPLE_RECORD, name: 'Renamed' } });
    const res = await PATCH(req({ machineId: 't1', workspaceId: 'ws-1', name: 'Renamed' }));
    expect(res.status).toBe(200);
    expect(mockBroadcastMachineWorkspaceEvent).toHaveBeenCalledWith(
      't1',
      'machine-workspace:updated',
      expect.objectContaining({ machineId: 't1', workspaceId: 'ws-1', name: 'Renamed' }),
    );
    const payload = mockBroadcastMachineWorkspaceEvent.mock.calls[0][2];
    expect(payload).not.toHaveProperty('columns');
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceId: 't1', details: { workspaceId: 'ws-1', fields: ['name'] } }),
    );
    // A name-only rename has no columns to mirror — the shim still bumps rev (grid: null).
    expect(mockSyncRelationalGrid).toHaveBeenCalledWith('t1', 'ws-1', null);
  });

  it('given a not_found workspace, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockUpdateWorkspace.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await PATCH(req({ machineId: 't1', workspaceId: 'missing', name: 'Renamed' }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/machines/workspaces', () => {
  it('given no edit access, returns 403 without removing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(
      new Request('https://x.test/api/machines/workspaces?machineId=t1&workspaceId=ws-1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect(mockRemoveWorkspace).not.toHaveBeenCalled();
  });

  it('given the workspace does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveWorkspace.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(
      new Request('https://x.test/api/machines/workspaces?machineId=t1&workspaceId=ws-1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('given a successful removal, returns 200, broadcasts machine-workspace:deleted, and audits data.delete', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveWorkspace.mockResolvedValue({ ok: true });
    const res = await DELETE(
      new Request('https://x.test/api/machines/workspaces?machineId=t1&workspaceId=ws-1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect(mockBroadcastMachineWorkspaceEvent).toHaveBeenCalledWith('t1', 'machine-workspace:deleted', {
      machineId: 't1',
      workspaceId: 'ws-1',
    });
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.delete', resourceId: 't1' }),
    );
    // The row (and its pane rows, via FK cascade) is already gone — the shim only bumps rev.
    expect(mockSyncRelationalGrid).toHaveBeenCalledWith('t1', 'ws-1', null);
    expect(mockBroadcastLegacyGridSync).toHaveBeenCalledWith('t1', 'ws-1', 1, null);
  });

  it('given no workspaceId, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/workspaces?machineId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});
