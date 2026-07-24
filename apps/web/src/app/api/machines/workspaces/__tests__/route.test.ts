/**
 * Contract tests for GET/POST/PATCH/DELETE /api/machines/workspaces
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockCanViewMachine,
  mockToWorkspaceDTO,
  mockCreateWorkspace,
  mockUpdateWorkspace,
  mockRemoveWorkspace,
  mockBroadcastMachineWorkspaceEvent,
  mockAuditRequest,
  mockGetConsistentWorkspaceSnapshot,
  mockSyncRelationalGrid,
  mockBroadcastLegacyGridSync,
  mockWithLegacyWorkspaceLock,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockToWorkspaceDTO: vi.fn(),
  mockCreateWorkspace: vi.fn(),
  mockUpdateWorkspace: vi.fn(),
  mockRemoveWorkspace: vi.fn(),
  mockBroadcastMachineWorkspaceEvent: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockGetConsistentWorkspaceSnapshot: vi.fn(),
  mockSyncRelationalGrid: vi.fn(),
  mockBroadcastLegacyGridSync: vi.fn(),
  mockWithLegacyWorkspaceLock: vi.fn(),
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
// (access checks, DTO mapping) are mocked.
vi.mock('@/lib/machines/machine-workspaces-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/machines/machine-workspaces-runtime')>();
  return {
    ...actual,
    canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
    canViewMachine: (...args: unknown[]) => mockCanViewMachine(...args),
    toWorkspaceDTO: (...args: unknown[]) => mockToWorkspaceDTO(...args),
  };
});

vi.mock('@pagespace/lib/services/machines/machine-workspaces', () => ({
  createWorkspace: (...args: unknown[]) => mockCreateWorkspace(...args),
  updateWorkspace: (...args: unknown[]) => mockUpdateWorkspace(...args),
  removeWorkspace: (...args: unknown[]) => mockRemoveWorkspace(...args),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastMachineWorkspaceEvent: (...args: unknown[]) => mockBroadcastMachineWorkspaceEvent(...args),
}));

// Rolling-deploy shim (#2202) — the relational sync side-effects of the
// legacy blob routes are DB-backed via `workspace-verbs-runtime.ts`'s lazy
// `machine-panes-store`; mocked here same as every other I/O dependency.
// `withLegacyWorkspaceLock` is mocked to just invoke its callback with fake
// deps/executor (no real transaction) — the callback's own `createWorkspace`/
// `updateWorkspace`/`removeWorkspace`/`syncRelationalGrid` calls are mocked
// separately, same as before this test moved them inside the lock.
vi.mock('@/lib/machines/workspace-verbs-runtime', () => ({
  getConsistentWorkspaceSnapshot: (...args: unknown[]) => mockGetConsistentWorkspaceSnapshot(...args),
  syncRelationalGrid: (...args: unknown[]) => mockSyncRelationalGrid(...args),
  broadcastLegacyGridSync: (...args: unknown[]) => mockBroadcastLegacyGridSync(...args),
  withLegacyWorkspaceLock: (...args: unknown[]) => mockWithLegacyWorkspaceLock(...args),
}));

import { GET, POST, PATCH, DELETE } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };
const FAKE_DEPS = { store: {} } as never;
const FAKE_EXECUTOR = {} as never;

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
  mockToWorkspaceDTO.mockImplementation(() => SAMPLE_DTO);
  mockSyncRelationalGrid.mockResolvedValue({ rev: 1, applied: true });
  // Simulates the real lock: run `mutate` with fake deps/executor, same as
  // `withMachineLock` would with a real transaction.
  mockWithLegacyWorkspaceLock.mockImplementation((_machineId: string, mutate: (deps: unknown, executor: unknown) => unknown) =>
    mutate(FAKE_DEPS, FAKE_EXECUTOR),
  );
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

  it('given no view access, returns 403 without reading a snapshot, and audits the denial', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/workspaces?machineId=t1'));
    expect(res.status).toBe(403);
    expect(mockGetConsistentWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied', resourceId: 't1' }),
    );
  });

  it('given view access, reports the consistent snapshot\'s workspaces and rev, and bootstrapped: true', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockGetConsistentWorkspaceSnapshot.mockResolvedValue({ workspaces: [SAMPLE_RECORD], rev: 7 });
    const res = await GET(new Request('https://x.test/api/machines/workspaces?machineId=t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bootstrapped).toBe(true);
    expect(body.workspaces).toEqual([SAMPLE_DTO]);
    expect(body.rev).toBe(7);
    expect(mockGetConsistentWorkspaceSnapshot).toHaveBeenCalledWith('t1');
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

  it('given no edit access, returns 403 without locking/creating', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req({ machineId: 't1', id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(403);
    expect(mockWithLegacyWorkspaceLock).not.toHaveBeenCalled();
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('given a fresh create, returns 201, broadcasts machine-workspace:created, and audits data.write', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockCreateWorkspace.mockResolvedValue({ ok: true, created: true, workspace: SAMPLE_RECORD });
    const res = await POST(req({ machineId: 't1', id: 'ws-1', name: 'Workspace 1', columns: [] }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    // The create + relational sync ran as ONE locked critical section.
    expect(mockWithLegacyWorkspaceLock).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(mockBroadcastMachineWorkspaceEvent).toHaveBeenCalledWith(
      't1',
      'machine-workspace:created',
      expect.objectContaining({ machineId: 't1', id: 'ws-1' }),
    );
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceId: 't1' }),
    );
    // Rolling-deploy shim: mirrors the create into the relational rows too,
    // through the SAME executor the lock handed the callback.
    expect(mockSyncRelationalGrid).toHaveBeenCalledWith('t1', 'ws-1', SAMPLE_RECORD.layout.columns, FAKE_EXECUTOR);
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

  it('given no edit access, returns 403 without locking/updating', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await PATCH(req({ machineId: 't1', workspaceId: 'ws-1', name: 'Renamed' }));
    expect(res.status).toBe(403);
    expect(mockWithLegacyWorkspaceLock).not.toHaveBeenCalled();
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
    expect(mockSyncRelationalGrid).toHaveBeenCalledWith('t1', 'ws-1', null, FAKE_EXECUTOR);
  });

  it('given a not_found workspace, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockUpdateWorkspace.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await PATCH(req({ machineId: 't1', workspaceId: 'missing', name: 'Renamed' }));
    expect(res.status).toBe(404);
    // A denial inside the lock must not have tried to sync a grid.
    expect(mockSyncRelationalGrid).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/machines/workspaces', () => {
  it('given no edit access, returns 403 without locking/removing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(
      new Request('https://x.test/api/machines/workspaces?machineId=t1&workspaceId=ws-1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect(mockWithLegacyWorkspaceLock).not.toHaveBeenCalled();
    expect(mockRemoveWorkspace).not.toHaveBeenCalled();
  });

  it('given the workspace does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockRemoveWorkspace.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(
      new Request('https://x.test/api/machines/workspaces?machineId=t1&workspaceId=ws-1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
    expect(mockSyncRelationalGrid).not.toHaveBeenCalled();
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
    expect(mockSyncRelationalGrid).toHaveBeenCalledWith('t1', 'ws-1', null, FAKE_EXECUTOR);
    expect(mockBroadcastLegacyGridSync).toHaveBeenCalledWith('t1', 'ws-1', 1, null);
  });

  it('given no workspaceId, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/workspaces?machineId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});
