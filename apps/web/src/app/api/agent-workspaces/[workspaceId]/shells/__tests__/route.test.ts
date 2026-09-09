// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockCheckSessionAccess,
  mockFindSessionRecord,
  mockProvisionSessionSandbox,
  mockListShells,
  mockSpawnShell,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
  mockFindSessionRecord: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
  mockListShells: vi.fn(),
  mockSpawnShell: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
  provisionSessionSandbox: (...args: unknown[]) => mockProvisionSessionSandbox(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-shells-runtime', () => ({
  listShells: (...args: unknown[]) => mockListShells(...args),
  spawnShell: (...args: unknown[]) => mockSpawnShell(...args),
}));

import { GET, POST } from '../route';

const AUTH_USER = { userId: 'user-1', role: 'admin' };
const SESSION_ID = 'ses-1';
const ROW = { id: SESSION_ID, ownerId: 'user-1', driveId: 'drive-1' };
const SHELL = {
  shellId: 'shell-row-1',
  workspaceId: SESSION_ID,
  ownerId: 'user-1',
  name: 'shell-1',
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

const params = { params: Promise.resolve({ workspaceId: SESSION_ID }) };
const get = () => GET(new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/shells`), params);
const post = (body?: unknown) =>
  POST(
    new Request(`http://localhost/api/agent-workspaces/${SESSION_ID}/shells`, {
      method: 'POST',
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_USER);
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
  mockFindSessionRecord.mockResolvedValue(ROW);
  mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: true });
  mockListShells.mockResolvedValue([SHELL]);
  mockSpawnShell.mockResolvedValue({ ok: true, shell: SHELL });
});

describe('GET /api/agent-workspaces/[workspaceId]/shells', () => {
  it('given an accessible session, should list its shells', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shells: [SHELL] });
  });

  it('given a session with no row yet, should answer an EMPTY list, not an error', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shells: [] });
    expect(mockListShells).not.toHaveBeenCalled();
  });

  it('given a denial, should answer an EMPTY list too — SAME as not-found (review #2261/5), but still audit', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'code_execution_denied' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shells: [] });
    expect(mockListShells).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });
});

describe('POST /api/agent-workspaces/[workspaceId]/shells', () => {
  it('given a cold session, should provision the sandbox BEFORE spawning — never mint a session', async () => {
    const order: string[] = [];
    mockProvisionSessionSandbox.mockImplementation(async () => {
      order.push('provision');
      return { ok: true, sandboxId: 'sb-1', resumed: false };
    });
    mockSpawnShell.mockImplementation(async () => {
      order.push('spawn');
      return { ok: true, shell: SHELL };
    });

    const response = await post({});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ shell: SHELL });
    expect(order).toEqual(['provision', 'spawn']);
    expect(mockSpawnShell).toHaveBeenCalledWith({ workspaceId: SESSION_ID, ownerId: 'user-1', name: undefined });
  });

  it('given a requested name, should pass it through for the pure planner to validate', async () => {
    await post({ name: 'build' });
    expect(mockSpawnShell).toHaveBeenCalledWith({ workspaceId: SESSION_ID, ownerId: 'user-1', name: 'build' });
  });

  it('given the pane the user picked into, should forward it as a placement preference', async () => {
    // A terminal ADMITS the way a conversation does, so without this the policy
    // takes the first pane that qualifies and the shell opens in a pane the
    // user did not click.
    await post({ activeNodeId: 'node-7' });
    expect(mockSpawnShell).toHaveBeenCalledWith({
      workspaceId: SESSION_ID,
      ownerId: 'user-1',
      name: undefined,
      activeNodeId: 'node-7',
    });
  });

  it('given a non-string pane preference, should spawn without one rather than refuse', async () => {
    // A preference, not an instruction: an unusable one is dropped, never a 400.
    await post({ activeNodeId: 42 });
    expect(mockSpawnShell).toHaveBeenCalledWith({ workspaceId: SESSION_ID, ownerId: 'user-1', name: undefined });
  });

  it('given no body at all, should still spawn with an auto-label', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(mockSpawnShell).toHaveBeenCalledWith({ workspaceId: SESSION_ID, ownerId: 'user-1', name: undefined });
  });

  it('given a non-string name, should 400 before touching anything', async () => {
    const response = await post({ name: 42 });
    expect(response.status).toBe(400);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given no such session, should 404 and never provision — a shell opens INSIDE a workspace', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'session_not_found' });
    const response = await post({});
    expect(response.status).toBe(404);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('given an access denial, should 404 (SAME as not-found, review #2261/5) and never provision or spawn', async () => {
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await post({});
    expect(response.status).toBe(404);
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given a taken name, should 409 with the reason token', async () => {
    mockSpawnShell.mockResolvedValue({ ok: false, reason: 'name_taken' });
    const response = await post({ name: 'build' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ reason: 'name_taken' }));
  });

  it('given NO requested name, should not report it as a name collision', async () => {
    // "A shell with that name already exists" names a name the caller never
    // chose — with no name supplied this can only be a lost auto-label race.
    mockSpawnShell.mockResolvedValue({ ok: false, reason: 'name_taken' });
    const response = await post({});
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.reason).toBe('name_taken');
    expect(body.error).not.toContain('that name');
    expect(body.error).toContain('Try again');
  });

  it('given an invalid name, should 400 with the reason token', async () => {
    mockSpawnShell.mockResolvedValue({ ok: false, reason: 'invalid_name' });
    const response = await post({ name: '-bad' });
    expect(response.status).toBe(400);
  });

  it('given a PLAN-LIMIT refusal, should 429 with the user-facing message and a rate-limit audit', async () => {
    // Untested until now, on a path this PR reworked repeatedly. Three things
    // matter and none was pinned: the status (429, not the 403 this started as
    // — a quota refusal is not an authorization failure), the audit event
    // (`security.rate.limited`, not `data.read`, so a free-tier user hitting
    // their ceiling is not filed as data-access forensics), and the route tag,
    // which became a PARAMETER when the duplicated helper was extracted and can
    // therefore now be passed wrong.
    //
    // `detail: 'concurrency_limit'` here is the REAL shape `checkAgentSessionConcurrency`
    // returns (packages/lib/src/services/sandbox/quota.ts) — a diagnostic enum,
    // not a sentence. A mock without it (as this test previously had) hid the P1
    // where that enum was rendered verbatim as `body.error` (PR #2253).
    mockProvisionSessionSandbox.mockResolvedValue({
      ok: false,
      reason: 'denied',
      denial: 'session_limit_reached',
      detail: 'concurrency_limit',
    });

    const response = await post({});

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toContain('sandbox');
    // The diagnostic enum must never leak into what the user reads.
    expect(body.error).not.toContain('concurrency_limit');
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'security.rate.limited',
        details: expect.objectContaining({
          reason: 'session_limit_reached',
          route: 'agent-workspaces/[workspaceId]/shells',
          // ...but IS still recorded, for diagnosis — just in the audit row.
          reasonCode: 'concurrency_limit',
        }),
      }),
    );
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given a TIER-INELIGIBLE provisioning denial, should 403 naming the plan gate (review #2326)', async () => {
    // The session surface is free for every drive member, so a free-tier payer
    // legitimately reaches this route — the denial must read as an upgrade
    // prompt, not a generic access problem the user could never resolve.
    mockProvisionSessionSandbox.mockResolvedValue({
      ok: false,
      reason: 'denied',
      denial: 'not_authorized',
      detail: 'tier_ineligible',
    });

    const response = await post({});

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Pro plan');
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'authz.access.denied',
        details: expect.objectContaining({ reason: 'not_authorized', detail: 'tier_ineligible' }),
      }),
    );
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given a provisioning failure, should 502 and never spawn a row pointing at nothing', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'provision_failed' });
    const response = await post({});
    expect(response.status).toBe(502);
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });
});
