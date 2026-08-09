// @vitest-environment node
/**
 * `/api/agent-workspaces/[workspaceId]/nodes` — the wire's own promises.
 *
 * The decisions are pinned deeper (packages/lib for the write decision, the
 * runtime suite for the gate and the broadcast); what belongs HERE is what only
 * the route can be wrong about: the not-found/denied family policy, that a
 * malformed payload never reaches the write at all, that a 409 carries the same
 * body a 200 does, that a refusal is 400 with the violation's own code while a
 * forbidden binding is a uniform 403, and that only a CHANGED write is audited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuth, mockAudit, mockAccess, mockApply, mockRead, mockDenied } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAudit: vi.fn(),
  mockAccess: vi.fn(),
  mockApply: vi.fn(),
  mockRead: vi.fn(),
  mockDenied: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuth(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: (...args: unknown[]) => mockAudit(...args) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn() } } }));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockAccess(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-node-runtime', () => ({
  applyWorkspaceNodeWrite: (...args: unknown[]) => mockApply(...args),
  readWorkspaceNodes: (...args: unknown[]) => mockRead(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-unavailable-response', () => ({
  workspaceNotFoundOrDenied: (...args: unknown[]) => {
    mockDenied(...args);
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
  },
}));

const { GET, POST } = await import('../route');

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const WORKSPACE = 'ws-1';
const params = { params: Promise.resolve({ workspaceId: WORKSPACE }) };

const root = { nodeType: 'root' as const, id: 'root', parentId: null, position: 0 as const, axis: 'row' as const };
const paneNode = { nodeType: 'pane' as const, id: 'pane-a', parentId: 'root', position: 0, target: null };
const SNAPSHOT = { rev: 4, nodes: [root, paneNode], targets: [] };

const post = (body?: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-workspaces/${WORKSPACE}/nodes`, {
      method: 'POST',
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : { body: 'not json', headers: { 'content-type': 'application/json' } }),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(AUTH_USER);
  mockAccess.mockResolvedValue({ allowed: true });
  mockRead.mockResolvedValue(SNAPSHOT);
  mockApply.mockResolvedValue({ status: 'ok', snapshot: { ...SNAPSHOT, rev: 5 }, changed: true });
});

describe('reaching the workspace at all', () => {
  it('answers the SAME 404 for an unknown workspace and a denied one, on both verbs', async () => {
    mockAccess.mockResolvedValue({ allowed: false, reason: 'not_found' });
    expect((await post({ baseRev: 4, put: [], drop: [] })).status).toBe(404);
    expect(
      (await GET(new Request(`http://localhost/api/agent-workspaces/${WORKSPACE}/nodes`), params)).status,
    ).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('the payload', () => {
  it('never reaches the write when it is not JSON, or not a write', async () => {
    expect((await post()).status).toBe(400);
    expect((await post({ baseRev: -1, put: [], drop: [] })).status).toBe(400);
    expect((await post({ put: [], drop: [] })).status).toBe(400);
    // A node whose type contradicts its own columns is a client that does not
    // hold this model, and the honest answer is 400 rather than a repair.
    expect(
      (await post({ baseRev: 4, drop: [], put: [{ nodeType: 'pane', id: 'p', parentId: 'root', position: 0, target: null, axis: 'row' }] }))
        .status,
    ).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('carries an UNKNOWN top-level field to a 400 rather than ignoring it', async () => {
    // `opId` is the one a caller is most likely to send out of habit. There is
    // no idempotency memory behind this route — the upsert makes a replay a
    // no-op by construction — and silently accepting the key would let a client
    // believe a guarantee nothing is providing.
    const response = await post({ baseRev: 4, put: [], drop: [], opId: 'op-1' });
    expect(response.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('the answers', () => {
  it('200 carries {rev, nodes, targets}', async () => {
    const response = await post({ baseRev: 4, put: [], drop: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...SNAPSHOT, rev: 5 });
  });

  it('409 carries the SAME body — the truth to rebase against, not an error to surrender to', async () => {
    mockApply.mockResolvedValue({ status: 'stale', snapshot: SNAPSHOT });
    const response = await post({ baseRev: 1, put: [], drop: [] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(SNAPSHOT);
  });

  it('400 carries the violation own code, so a client knows WHICH invariant it broke', async () => {
    mockApply.mockResolvedValue({ status: 'refused', code: 'dangling_parent', detail: 'node "x" is parented to "y"' });
    const response = await post({ baseRev: 4, put: [], drop: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'dangling_parent' });
  });

  it('400 for a payload naming another workspace — never a 409 inviting it to try again', async () => {
    mockApply.mockResolvedValue({ status: 'refused', code: 'foreign_scope', detail: 'node "x" claims ws-2' });
    expect((await post({ baseRev: 4, put: [], drop: [] })).status).toBe(400);
  });

  it('403 for a binding the caller may not make, and says nothing about which', async () => {
    mockApply.mockResolvedValue({
      status: 'refused',
      code: 'forbidden_target',
      detail: 'You cannot show that in this workspace.',
    });
    const response = await post({ baseRev: 4, put: [], drop: [] });
    expect(response.status).toBe(403);
    // Uniform across "forbidden" and "no such target", so a caller probing ids
    // learns nothing from the difference.
    expect(await response.json()).toEqual({ error: 'You cannot show that in this workspace.' });
  });
});

describe('the audit', () => {
  it('records a write that CHANGED something, and stays silent on a no-op', async () => {
    await post({ baseRev: 4, put: [], drop: [] });
    expect(mockAudit).toHaveBeenCalledTimes(1);

    mockAudit.mockClear();
    mockApply.mockResolvedValue({ status: 'ok', snapshot: SNAPSHOT, changed: false });
    const response = await post({ baseRev: 4, put: [], drop: [] });
    expect(response.status).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('the GET', () => {
  it('serves the snapshot for THIS viewer', async () => {
    const response = await GET(new Request(`http://localhost/api/agent-workspaces/${WORKSPACE}/nodes`), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SNAPSHOT);
    expect(mockRead).toHaveBeenCalledWith(WORKSPACE, AUTH_USER.userId);
  });
});
