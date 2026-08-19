// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockListSessions,
  mockListShellsBulk,
  mockListSessionConversationsBulk,
  mockReadWorkspaceNodesBulk,
  mockCountActiveSessionsForOwner,
  mockCheckAccessForSubject,
  mockCreateConversationInSession,
  mockEndSession,
  mockSpawnSession,
  mockGetAiAgent,
  mockGetConversation,
  mockCanPrincipalViewPage,
  mockProvisionSessionSandbox,
  mockSpawnShell,
  mockFindSessionRecord,
  mockClaimConversationInSession,
  mockFindWorkspaceOfConversation,
  mockCheckSessionAccess,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockListSessions: vi.fn(),
  mockListShellsBulk: vi.fn(),
  mockListSessionConversationsBulk: vi.fn(),
  mockReadWorkspaceNodesBulk: vi.fn(),
  mockCountActiveSessionsForOwner: vi.fn(),
  mockCheckAccessForSubject: vi.fn(),
  mockCreateConversationInSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockSpawnSession: vi.fn(),
  mockGetAiAgent: vi.fn(),
  mockGetConversation: vi.fn(),
  mockCanPrincipalViewPage: vi.fn(),
  mockProvisionSessionSandbox: vi.fn(),
  mockSpawnShell: vi.fn(),
  mockFindSessionRecord: vi.fn(),
  mockClaimConversationInSession: vi.fn(),
  mockFindWorkspaceOfConversation: vi.fn(),
  mockCheckSessionAccess: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
  canPrincipalViewPage: (...args: unknown[]) => mockCanPrincipalViewPage(...args),
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getAiAgent: (...args: unknown[]) => mockGetAiAgent(...args),
    getConversation: (...args: unknown[]) => mockGetConversation(...args),
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  listSessionConversationsBulk: (...args: unknown[]) => mockListSessionConversationsBulk(...args),
  countActiveSessionsForOwner: (...args: unknown[]) => mockCountActiveSessionsForOwner(...args),
  MAX_ACTIVE_SESSIONS_PER_OWNER: 100,
  checkAccessForSubject: (...args: unknown[]) => mockCheckAccessForSubject(...args),
  createConversationInSession: (...args: unknown[]) => mockCreateConversationInSession(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  spawnSession: (...args: unknown[]) => mockSpawnSession(...args),
  toSessionDTOWithEnv: async (row: { id: string }) => ({ workspaceId: row.id, dto: true }),
  provisionSessionSandbox: (...args: unknown[]) => mockProvisionSessionSandbox(...args),
  findSessionRecord: (...args: unknown[]) => mockFindSessionRecord(...args),
  claimConversationInSession: (...args: unknown[]) => mockClaimConversationInSession(...args),
  findWorkspaceOfConversation: (...args: unknown[]) => mockFindWorkspaceOfConversation(...args),
  checkSessionAccess: (...args: unknown[]) => mockCheckSessionAccess(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-shells-runtime', () => ({
  listShellsBulk: (...args: unknown[]) => mockListShellsBulk(...args),
  spawnShell: (...args: unknown[]) => mockSpawnShell(...args),
}));
vi.mock('@/lib/agent-workspaces/workspace-node-runtime', () => ({
  readWorkspaceNodesBulk: (...args: unknown[]) => mockReadWorkspaceNodesBulk(...args),
}));

import { GET, POST } from '../route';

const AUTH_ADMIN = { userId: 'user-1', role: 'admin' };
const AUTH_NON_ADMIN = { userId: 'user-2', role: 'user' };

const SESSION_DTO = {
  workspaceId: 'ses-1',
  driveId: 'drive-1',
  ownerId: 'user-1',
  name: 'worker',
  sandboxStatus: 'running',
  createdAt: '2026-07-28T00:00:00.000Z',
  lastActiveAt: null,
  endedAt: null,
};

const SHELL_DTO = {
  shellId: 'shell-row-1',
  workspaceId: 'ses-1',
  ownerId: 'user-1',
  name: 'shell-1',
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

const CONVERSATION_ENTRY = {
  conversationId: 'conv-1',
  title: 'First chat',
  agentPageId: 'agent-1',
  lastMessageAt: '2026-07-28T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_ADMIN);
  mockListSessions.mockResolvedValue([SESSION_DTO]);
  mockListShellsBulk.mockResolvedValue(new Map([['ses-1', [SHELL_DTO]]]));
  mockListSessionConversationsBulk.mockResolvedValue(new Map([['ses-1', [CONVERSATION_ENTRY]]]));
  mockReadWorkspaceNodesBulk.mockResolvedValue(new Map());
  mockCountActiveSessionsForOwner.mockResolvedValue(0);
  // Default: the caller CAN open whatever workspace a claim conflict names.
  // The tests that care about the denial path say so explicitly.
  mockCheckSessionAccess.mockResolvedValue({ allowed: true });
});

describe('GET /api/agent-workspaces', () => {
  it('given an admin with no filter, should list THEIR sessions with shells AND conversations attached', async () => {
    const response = await GET(new Request('http://localhost/api/agent-workspaces'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      // The listing is handed through UNCHANGED. Every entry already carries
      // its own `nodeId`, read off the node that decided the thread is in this
      // workspace at all — so there is nothing for the route to annotate it
      // with, and `annotateConversationsWithPanes` is deleted rather than
      // ported (issue #2373).
      sessions: [
        {
          ...SESSION_DTO,
          shells: [SHELL_DTO],
          conversations: [CONVERSATION_ENTRY],
          rev: 0,
          nodes: [],
          targets: [],
        },
      ],
    });
    expect(mockListSessions).toHaveBeenCalledWith({ ownerId: 'user-1' });
    // ONE bulk call each, however many sessions — the poll must not be 1+3N.
    expect(mockListSessionConversationsBulk).toHaveBeenCalledTimes(1);
    expect(mockListSessionConversationsBulk).toHaveBeenCalledWith(['ses-1']);
    expect(mockListShellsBulk).toHaveBeenCalledWith(['ses-1']);
    // The tree is a permissioned join (security review HIGH 1) — the bulk read
    // names the viewer it is resolving titles for.
    expect(mockReadWorkspaceNodesBulk).toHaveBeenCalledWith(['ses-1'], 'user-1');
  });

  /**
   * ONE LIST, NOT TWO (issue #2373), and now one ROW. The route used to hand
   * back the flat conversations AND the grid and let the client choose;
   * `AgentsSidebar` chose the grid, so a thread with no pane row was invisible.
   *
   * The reconciliation that fixed it is gone too, because there is nothing left
   * to reconcile: membership is the node, so a thread is in this listing exactly
   * when a node of this workspace binds it, and that node's id rides along. This
   * is the guard that replaces the deleted annotation's suite, so what it has to
   * pin is the ABSENCE of annotation: whatever the store answers is what the
   * client gets, key for key.
   *
   * It pins that with `toEqual` on the whole array rather than `toMatchObject`
   * on each entry, because the failure this guards against is the route ADDING a
   * derived field back — `attached` was one, deleted with the grid it
   * reconciled against — and a per-key match would not see one arrive.
   */
  it('hands the listing back exactly as the store answered it — no annotation, no derived state', async () => {
    const entries = [
      { ...CONVERSATION_ENTRY, nodeId: 'node-1' },
      { ...CONVERSATION_ENTRY, conversationId: 'conv-2', nodeId: 'node-2' },
    ];
    mockListSessionConversationsBulk.mockResolvedValue(new Map([['ses-1', entries]]));

    const body = await (await GET(new Request('http://localhost/api/agent-workspaces'))).json();

    expect(body.sessions[0].conversations).toEqual(entries);
  });

  /**
   * THE TREE, per session — the sidebar's own source now that it renders the
   * live tree out of the store instead of this snapshot. The legacy `workspace`
   * grid above stays for the rolling-deploy window; nothing client-side reads it.
   */
  it('attaches each session\'s node tree, so the sidebar can seat it', async () => {
    const nodes = [
      { nodeType: 'root', id: 'ses-1', parentId: null, position: 0, axis: 'row' },
      { nodeType: 'pane', id: 'n1', parentId: 'ses-1', position: 0, target: { kind: 'chat', id: 'conv-1' } },
    ];
    const targets = [
      { id: 'conv-1', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: 'agent-1' },
    ];
    mockReadWorkspaceNodesBulk.mockResolvedValue(new Map([['ses-1', { rev: 7, nodes, targets }]]));

    const body = await (await GET(new Request('http://localhost/api/agent-workspaces'))).json();

    expect(body.sessions[0].rev).toBe(7);
    expect(body.sessions[0].nodes).toEqual(nodes);
    expect(body.sessions[0].targets).toEqual(targets);
    // Resolved once per VIEWER, so the read is authorized for whoever asked.
    expect(mockReadWorkspaceNodesBulk).toHaveBeenCalledWith(['ses-1'], 'user-1');
  });

  it('answers an empty tree at rev 0 for a workspace the node read did not return', async () => {
    // "Never written" and "vanished between the two reads" get the same honest
    // answer — the client seats both identically rather than keeping stale nodes.
    mockReadWorkspaceNodesBulk.mockResolvedValue(new Map());
    const body = await (await GET(new Request('http://localhost/api/agent-workspaces'))).json();
    expect(body.sessions[0]).toMatchObject({ rev: 0, nodes: [], targets: [] });
  });

  it('given ?driveId=, should narrow WHERE but never WHOSE (ownerId still rides the filter)', async () => {
    await GET(new Request('http://localhost/api/agent-workspaces?driveId=drive-1'));
    expect(mockListSessions).toHaveBeenCalledWith({ driveId: 'drive-1', ownerId: 'user-1' });
  });

  it('given ?agentId=, should IGNORE it — a session hosts many agents, so no such filter exists', async () => {
    await GET(new Request('http://localhost/api/agent-workspaces?agentId=page-1'));
    expect(mockListSessions).toHaveBeenCalledWith({ ownerId: 'user-1' });
  });

  it('given a non-admin, should list THEIR OWN sessions same as an admin — sessions/chat/panes are open to every authenticated user, only the sandbox itself is tier-gated', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_NON_ADMIN);
    const response = await GET(new Request('http://localhost/api/agent-workspaces'));
    expect(response.status).toBe(200);
    expect(mockListSessions).toHaveBeenCalledWith({ ownerId: 'user-2' });
  });

  it('given an auth failure, should return the auth error untouched', async () => {
    const error = new Response(null, { status: 401 });
    mockAuthenticateRequest.mockResolvedValue({ error });
    const response = await GET(new Request('http://localhost/api/agent-workspaces'));
    expect(response.status).toBe(401);
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('given a listing failure, should 500 with a human error', async () => {
    mockListSessions.mockRejectedValue(new Error('db down'));
    const response = await GET(new Request('http://localhost/api/agent-workspaces'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to list agent sessions' });
  });
});


describe('POST /api/agent-workspaces — spawn', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: false });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockListSessions.mockResolvedValue([]);
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: false });
    mockSpawnShell.mockResolvedValue({
      ok: true,
      shell: { shellId: 'shell-new', workspaceId: 'ses-new', ownerId: 'user-1', name: 'Shell', agentType: 'shell', command: null, createdAt: '2026-07-28T00:00:00.000Z' },
    });
  });

  it('spawns ONE session with ONE bound conversation — and NO sandbox', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', name: 'api refactor' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session).toEqual({ workspaceId: 'ses-new', dto: true });
    expect(typeof body.conversationId).toBe('string');
    expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: 'drive-1', envId: null, name: 'api refactor' });
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: 'agent-1', workspaceId: 'ses-new', userId: 'user-1' }),
    );
    // Spawn is instant and free: nothing here may provision a sandbox.
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
  });

  it('spawns a GLOBAL-ASSISTANT session from the both-null shape, auto-naming it "Global Assistant"', async () => {
    const response = await spawn({});
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: null, envId: null, name: 'Global Assistant' });
    // The first conversation is an assistant thread: no agent page.
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: null, workspaceId: 'ses-new' }),
    );
    // And the access decision saw the global subject (driveId null → owner-only).
    expect(mockCheckAccessForSubject).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ driveId: null }),
    );
  });

  it('spawns a DRIVE session from the drive-only shape, first conversation is the assistant', async () => {
    const response = await spawn({ driveId: 'drive-1' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: 'drive-1', envId: null, name: 'Global Assistant' });
    expect(mockCreateConversationInSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: null, workspaceId: 'ses-new' }),
    );
    // The access decision saw the DRIVE subject, not the global one.
    expect(mockCheckAccessForSubject).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ driveId: 'drive-1' }),
    );
  });

  it('refuses the one unresolvable shape — an agent without its drive', async () => {
    const response = await spawn({ agentPageId: 'agent-1' });
    expect(response.status).toBe(400);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('gates on the shared access decision BEFORE minting anything', async () => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: false, reason: 'drive_access_denied' });
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(403);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('given the first conversation fails, ENDS the just-minted session — no empty workspace exists', async () => {
    mockCreateConversationInSession.mockRejectedValue(new Error('squat guard refused'));
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(502);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
  });
});

describe("POST /api/agent-workspaces — firstThing: 'shell'", () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: false });
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockListSessions.mockResolvedValue([]);
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: false });
    mockSpawnShell.mockResolvedValue({
      ok: true,
      shell: { shellId: 'shell-new', workspaceId: 'ses-new', ownerId: 'user-1', name: 'Shell', agentType: 'shell', command: null, createdAt: '2026-07-28T00:00:00.000Z' },
    });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCreateConversationInSession.mockResolvedValue(undefined);
  });

  it("given firstThing: 'shell', should provision the sandbox then spawn a shell — NOT a conversation — and respond { session, shellId, shellName }", async () => {
    const order: string[] = [];
    mockProvisionSessionSandbox.mockImplementation(async () => {
      order.push('provision');
      return { ok: true, sandboxId: 'sb-1', resumed: false };
    });
    mockSpawnShell.mockImplementation(async () => {
      order.push('spawn');
      return {
        ok: true,
        shell: { shellId: 'shell-new', workspaceId: 'ses-new', ownerId: 'user-1', name: 'Shell', agentType: 'shell', command: null, createdAt: '2026-07-28T00:00:00.000Z' },
      };
    });

    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ session: { workspaceId: 'ses-new', dto: true }, shellId: 'shell-new', shellName: 'Shell' });
    expect(order).toEqual(['provision', 'spawn']);
    expect(mockProvisionSessionSandbox).toHaveBeenCalledWith({ id: 'ses-new' }, 'user-1');
    expect(mockSpawnShell).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ses-new', ownerId: 'user-1' }));
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
  });

  it("given the shell auto-labels itself differently from the session's own name, responds with the SHELL's actual name (not the session label)", async () => {
    mockSpawnShell.mockResolvedValue({
      ok: true,
      shell: { shellId: 'shell-new', workspaceId: 'ses-new', ownerId: 'user-1', name: 'Shell 2', agentType: 'shell', command: null, createdAt: '2026-07-28T00:00:00.000Z' },
    });

    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell', name: 'My Custom Session' });
    const body = await response.json();
    expect(body.shellName).toBe('Shell 2');
  });

  it("given firstThing omitted, should behave exactly as today — first conversation, no shell", async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(body.shellId).toBeUndefined();
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it("given firstThing is some other value, should behave exactly as today — first conversation, no shell", async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', firstThing: 'conversation' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.conversationId).toBe('string');
    expect(mockProvisionSessionSandbox).not.toHaveBeenCalled();
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given the sandbox fails to provision, ENDS the just-minted session and never spawns a shell', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({ ok: false, reason: 'provision_failed' });
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(502);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  it('given the first shell fails to spawn, ENDS the just-minted session', async () => {
    mockSpawnShell.mockResolvedValue({ ok: false, reason: 'error' });
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(502);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
  });

  // Codex review finding on PR #2284: a live-sandbox quota denial during shell-first
  // provisioning was reported as a generic 502 instead of the actionable 429 the
  // [workspaceId]/shells/route.ts POST already gives the same denial.
  it('given sandbox provisioning is denied for hitting the live-sandbox quota, ENDS the session and responds 429 (not 502)', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({
      ok: false,
      reason: 'denied',
      denial: 'session_limit_reached',
      detail: 'concurrency_limit',
    });
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(429);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  // Review #2326: the session surface is free for every drive member, so a
  // free-tier payer legitimately reaches shell-first provisioning — the
  // provisioner's tier denial is an entitlement fact and must respond 403
  // naming the plan gate, not a generic 502 infrastructure failure.
  it('given sandbox provisioning is denied for tier ineligibility, ENDS the session and responds 403 naming the plan gate (not 502)', async () => {
    mockProvisionSessionSandbox.mockResolvedValue({
      ok: false,
      reason: 'denied',
      denial: 'not_authorized',
      detail: 'tier_ineligible',
    });
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Pro plan');
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
    expect(mockSpawnShell).not.toHaveBeenCalled();
  });

  // Codex review finding on PR #2284: spawned.session is the PRE-provision row, so
  // responding with it directly reports a stale sandboxStatus even though provisioning
  // just succeeded. The route must refetch before building the response DTO.
  it('given the shell spawns successfully, refetches the session row after provisioning rather than reporting the stale pre-provision one', async () => {
    mockFindSessionRecord.mockResolvedValue({ id: 'ses-new', sandboxStatus: 'running' });
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(201);
    expect(mockFindSessionRecord).toHaveBeenCalledWith('ses-new');
  });
});

describe("POST /api/agent-workspaces — firstThing: 'claim'", () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  const UNBOUND_PAGE_CONVERSATION = {
    id: 'conv-1',
    userId: 'user-1',
    type: 'page',
    contextId: 'agent-1',
    workspaceId: null,
    isActive: true,
  };

  const UNBOUND_GLOBAL_CONVERSATION = {
    id: 'conv-1',
    userId: 'user-1',
    type: 'global',
    contextId: null,
    workspaceId: null,
    isActive: true,
  };

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: false });
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockListSessions.mockResolvedValue([]);
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockGetConversation.mockResolvedValue(UNBOUND_PAGE_CONVERSATION);
    mockClaimConversationInSession.mockResolvedValue('claimed');
    // MEMBERSHIP, from the tree — the successor to reading the row's own column.
    mockFindWorkspaceOfConversation.mockResolvedValue(null);
  });

  it('spawns a session and claims the existing conversation — createConversationInSession is never called', async () => {
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ session: { workspaceId: 'ses-new', dto: true }, conversationId: 'conv-1' });
    expect(mockSpawnSession).toHaveBeenCalledWith({ userId: 'user-1', driveId: 'drive-1', envId: null, name: 'Agent' });
    expect(mockClaimConversationInSession).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      workspaceId: 'ses-new',
    });
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ op: 'spawn_session', claimed: true }) }),
    );
  });

  it("derives the drive from the claimed conversation's own agent for a type:'page' row", async () => {
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(expect.objectContaining({ driveId: 'drive-1' }));
  });

  it('refuses a body driveId that disagrees with the claimed page conversation\'s own agent drive', async () => {
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1', driveId: 'drive-other' });
    expect(response.status).toBe(400);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('accepts a body driveId for a type:\'global\' claimed conversation, spawning a drive-scoped session', async () => {
    mockGetConversation.mockResolvedValue(UNBOUND_GLOBAL_CONVERSATION);
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1', driveId: 'drive-1' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(expect.objectContaining({ driveId: 'drive-1' }));
    expect(mockGetAiAgent).not.toHaveBeenCalled();
  });

  it('omitted driveId for a type:\'global\' claimed conversation spawns a GLOBAL session', async () => {
    mockGetConversation.mockResolvedValue(UNBOUND_GLOBAL_CONVERSATION);
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(expect.objectContaining({ driveId: null }));
  });

  it('400s when conversationId is missing', async () => {
    const response = await spawn({ firstThing: 'claim' });
    expect(response.status).toBe(400);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('400s when combined with an agentPageId — the agent is derived from the row, never the request', async () => {
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(400);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('404s a conversation that is missing, foreign-owned, or inactive — uniform "not found"', async () => {
    mockGetConversation.mockResolvedValue(null);
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(404);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('409s a conversation that some workspace\'s tree already holds, NAMING that workspace so the caller can open it', async () => {
    // The refusal carries its own remedy. Without the id the client has
    // nothing to act on and treats "already belongs to a session" as a dead
    // end — which is how a normal history click ended up on /dashboard.
    // Disclosure is safe: the ownership check above already 404s anything the
    // caller does not own, so this can only ever name the caller's own
    // workspace.
    mockFindWorkspaceOfConversation.mockResolvedValue('ses-other');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ workspaceId: 'ses-other' });
    expect(mockCheckSessionAccess).toHaveBeenCalledWith('user-1', 'ses-other');
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('409s WITHOUT naming a workspace the caller cannot open — owning the conversation is not access to the session holding it', async () => {
    // Any accepted drive member may create their own conversation inside
    // another member's drive session, and that membership can lapse while
    // conversation ownership never does. The 404 above proves only "this
    // conversation is yours", so the id goes through the same centralized gate
    // every other workspace route uses. The listing route already masks
    // `workspaceId` in this exact situation; without this the 409 would
    // disclose what the listing deliberately hides, and the client would
    // select a workspace it cannot open.
    mockFindWorkspaceOfConversation.mockResolvedValue('ses-someone-elses');
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'not_a_member' });
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.not.toHaveProperty('workspaceId');
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('403s + audits when the caller cannot view the agent page — owning the conversation is not permission to use the agent', async () => {
    mockCanPrincipalViewPage.mockResolvedValue(false);
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(403);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('given the claim loses a race after the preflight (not_found), ENDS the just-minted session and responds 409 — same conflict, same status the preflight itself would give it, not a server fault', async () => {
    mockClaimConversationInSession.mockResolvedValue('not_found');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(409);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
  });

  it('given the race was lost to another claim, the 409 NAMES the workspace that won it', async () => {
    // The preflight saw no workspace (first call), then the atomic claim came
    // back `not_found` because someone else got there first — so by the time
    // we look again (second call) the winner exists. Same reasoning as the
    // preflight's 409: the caller wanted this conversation in a workspace, one
    // now exists, and it is theirs.
    mockFindWorkspaceOfConversation.mockResolvedValueOnce(null).mockResolvedValue('ses-winner');
    mockClaimConversationInSession.mockResolvedValue('not_found');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ workspaceId: 'ses-winner' });
  });

  it('given the race was lost to a workspace the caller cannot open, the 409 still names nothing', async () => {
    mockFindWorkspaceOfConversation.mockResolvedValueOnce(null).mockResolvedValue('ses-someone-elses');
    mockCheckSessionAccess.mockResolvedValue({ allowed: false, reason: 'not_a_member' });
    mockClaimConversationInSession.mockResolvedValue('not_found');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.not.toHaveProperty('workspaceId');
  });

  it('given the race was lost for some other reason, the 409 names no workspace rather than inventing one', async () => {
    mockClaimConversationInSession.mockResolvedValue('not_found');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.not.toHaveProperty('workspaceId');
  });

  it('given claim fails for a truly unexpected outcome, ENDS the session and responds 502', async () => {
    mockClaimConversationInSession.mockResolvedValue('session_full');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(502);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
  });

  it('given a cross-drive denial from claim, ENDS the session and responds 400', async () => {
    mockClaimConversationInSession.mockResolvedValue('cross_drive_denied');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(400);
    expect(mockEndSession).toHaveBeenCalledWith('ses-new');
  });

  it('an idempotent already_in_session claim outcome still succeeds', async () => {
    mockClaimConversationInSession.mockResolvedValue('already_in_session');
    const response = await spawn({ firstThing: 'claim', conversationId: 'conv-1' });
    expect(response.status).toBe(201);
    expect(mockEndSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-workspaces — spawn agent validation (review M6)', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
  });

  it('404s an unknown/non-agent page BEFORE minting anything', async () => {
    mockGetAiAgent.mockResolvedValue(null);
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'ghost' });
    expect(response.status).toBe(404);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it("400s an agent from a DIFFERENT drive — a session hosts only its own drive's agents", async () => {
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-other' });
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(400);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('403s an agent the requester cannot view, and audits it', async () => {
    mockCanPrincipalViewPage.mockResolvedValue(false);
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(403);
    expect(mockSpawnSession).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  it('caps the stored name — a label rendered everywhere must stay bounded', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', name: 'x'.repeat(500) });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'x'.repeat(120) }),
    );
  });
});

describe('POST /api/agent-workspaces — blank name auto-generates a unique one', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue({ ok: true, spriteTornDown: false });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Research Bot', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockListSessions.mockResolvedValue([]);
    mockProvisionSessionSandbox.mockResolvedValue({ ok: true, sandboxId: 'sb-1', resumed: false });
    mockSpawnShell.mockResolvedValue({
      ok: true,
      shell: { shellId: 'shell-new', workspaceId: 'ses-new', ownerId: 'user-1', name: 'Shell', agentType: 'shell', command: null, createdAt: '2026-07-28T00:00:00.000Z' },
    });
  });

  it('given a blank name with an agent, should derive the base label from the agent title', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', name: '' });
    expect(response.status).toBe(201);
    expect(mockListSessions).toHaveBeenCalledWith({ ownerId: 'user-1' });
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Research Bot' }),
    );
  });

  it('given an omitted name with an agent, should derive the base label from the agent title', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Research Bot' }),
    );
  });

  it("given a blank name with firstThing: 'shell', should derive the base label \"Shell\"", async () => {
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Shell' }),
    );
  });

  it('given a blank name for the global-assistant shape, should derive the base label "Global Assistant"', async () => {
    const response = await spawn({});
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Global Assistant' }),
    );
  });

  it('given a non-blank name, should use it as-is — no collision lookup at all', async () => {
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1', name: 'api refactor' });
    expect(response.status).toBe(201);
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'api refactor' }),
    );
  });

  it('given the base label already taken, should append " 2" rather than collide', async () => {
    mockListSessions.mockResolvedValue([
      { workspaceId: 'ses-old', driveId: null, ownerId: 'user-1', name: 'Shell', sandboxStatus: 'ended', createdAt: '2026-07-28T00:00:00.000Z', lastActiveAt: null, endedAt: null },
    ]);
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Shell 2' }),
    );
  });

  it('given two blank-named shell spawns back to back, should produce two distinct names', async () => {
    mockListSessions.mockResolvedValueOnce([]);
    const first = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(mockSpawnSession).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Shell' }));

    mockListSessions.mockResolvedValueOnce([
      { workspaceId: 'ses-old', driveId: 'drive-1', ownerId: 'user-1', name: 'Shell', sandboxStatus: 'running', createdAt: '2026-07-28T00:00:00.000Z', lastActiveAt: null, endedAt: null },
    ]);
    const second = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(mockSpawnSession).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Shell 2' }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('given "Shell" and "Shell 2" both taken, should scan past both collisions to "Shell 3"', async () => {
    mockListSessions.mockResolvedValue([
      { workspaceId: 'ses-1', driveId: 'drive-1', ownerId: 'user-1', name: 'Shell', sandboxStatus: 'running', createdAt: '2026-07-28T00:00:00.000Z', lastActiveAt: null, endedAt: null },
      { workspaceId: 'ses-2', driveId: 'drive-1', ownerId: 'user-1', name: 'Shell 2', sandboxStatus: 'running', createdAt: '2026-07-28T00:00:00.000Z', lastActiveAt: null, endedAt: null },
    ]);
    const response = await spawn({ driveId: 'drive-1', firstThing: 'shell' });
    expect(response.status).toBe(201);
    expect(mockSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Shell 3' }),
    );
  });
});

describe('POST /api/agent-workspaces — spawn ceiling (review M6/F4)', () => {
  const spawn = (body: unknown) =>
    POST(
      new Request('http://localhost/api/agent-workspaces', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('429s at the active-session ceiling — spawn is free, but not unbounded', async () => {
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(100);
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(429);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  it('passes an envId straight through, unvalidated — the service owns that check so every caller inherits it', async () => {
    // Ships dark: nothing SENDS this yet. Validating the env here instead would
    // put "does it exist, is it this drive's" in a route rather than in
    // `spawnAgentSession`, where the realtime tier and the tools would each
    // need their own copy of it.
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'ses-new' } });
    await spawn({ driveId: 'drive-1', envId: 'env-1' });
    expect(mockSpawnSession).toHaveBeenCalledWith(expect.objectContaining({ envId: 'env-1' }));
  });

  it('404s when the env does not exist, or belongs to another drive — one answer for both', async () => {
    // The service collapses the two deliberately, so a caller who cannot see a
    // drive cannot enumerate its environments through spawn errors either.
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockSpawnSession.mockResolvedValue({ ok: false, reason: 'env_not_found' });
    const response = await spawn({ driveId: 'drive-1', envId: 'env-elsewhere' });
    expect(response.status).toBe(404);
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
  });

  it('429s on the ATOMIC backstop when a concurrent spawn wins the race the pre-check missed (review #2261/2)', async () => {
    // The pre-check above is advisory (TOCTOU-racy on its own) — spawnSession
    // itself is the authoritative, atomically-enforced ceiling, and its
    // refusal must reach the caller the same way the pre-check's does.
    mockCheckAccessForSubject.mockResolvedValue({ allowed: true });
    mockGetAiAgent.mockResolvedValue({ id: 'agent-1', title: 'Agent', type: 'AI_CHAT', driveId: 'drive-1' });
    mockCanPrincipalViewPage.mockResolvedValue(true);
    mockCountActiveSessionsForOwner.mockResolvedValue(0);
    mockSpawnSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });
    const response = await spawn({ driveId: 'drive-1', agentPageId: 'agent-1' });
    expect(response.status).toBe(429);
    expect(mockCreateConversationInSession).not.toHaveBeenCalled();
  });
});
