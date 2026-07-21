/**
 * Contract tests for GET/POST/DELETE /api/machines/agent-terminals
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockCanViewMachine,
  mockBuildSpawnAgentTerminalDeps,
  mockBuildKillAgentTerminalDeps,
  mockBuildListAgentTerminalsDeps,
  mockIsCodeExecutionEnabled,
  mockSpawnAgentTerminal,
  mockKillAgentTerminal,
  mockListAgentTerminals,
  mockCreateConversation,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockBuildSpawnAgentTerminalDeps: vi.fn(),
  mockBuildKillAgentTerminalDeps: vi.fn(),
  mockBuildListAgentTerminalsDeps: vi.fn(),
  mockIsCodeExecutionEnabled: vi.fn(),
  mockSpawnAgentTerminal: vi.fn(),
  mockKillAgentTerminal: vi.fn(),
  mockListAgentTerminals: vi.fn(),
  mockCreateConversation: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/machines/agent-terminals-runtime', () => ({
  buildSpawnAgentTerminalDeps: (...args: unknown[]) => mockBuildSpawnAgentTerminalDeps(...args),
  buildKillAgentTerminalDeps: (...args: unknown[]) => mockBuildKillAgentTerminalDeps(...args),
  buildListAgentTerminalsDeps: (...args: unknown[]) => mockBuildListAgentTerminalsDeps(...args),
  canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  canViewMachine: (...args: unknown[]) => mockCanViewMachine(...args),
  isCodeExecutionEnabled: (...args: unknown[]) => mockIsCodeExecutionEnabled(...args),
}));

vi.mock('@pagespace/lib/services/machines/agent-terminals', () => ({
  spawnAgentTerminal: (...args: unknown[]) => mockSpawnAgentTerminal(...args),
  killAgentTerminal: (...args: unknown[]) => mockKillAgentTerminal(...args),
  listAgentTerminals: (...args: unknown[]) => mockListAgentTerminals(...args),
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    createConversation: (...args: unknown[]) => mockCreateConversation(...args),
  },
}));

import { GET, POST, DELETE } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };
const FAKE_DEPS = { store: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockBuildSpawnAgentTerminalDeps.mockReturnValue(FAKE_DEPS);
  mockBuildKillAgentTerminalDeps.mockResolvedValue(FAKE_DEPS);
  mockBuildListAgentTerminalsDeps.mockReturnValue(FAKE_DEPS);
  mockIsCodeExecutionEnabled.mockReturnValue(true);
  mockCreateConversation.mockResolvedValue(undefined);
});

describe('GET /api/machines/agent-terminals', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(401);
  });

  it('given view access, lists the branch agent terminals', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({
      ok: true,
      terminals: [{ id: 'agent-terminal-1', name: 'cli', agentType: 'shell', createdAt: new Date('2026-07-01') }],
    });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentTerminals).toHaveLength(1);
    expect(body.agentTerminals[0].id).toBe('agent-terminal-1');
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', 't1');
    expect(mockListAgentTerminals).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: 'repo', branchName: 'main' }),
    );
  });

  it('given a legacy row whose agentType is the retired pagespace-cli, still lists it as-is — launchability is the client\'s call via isAgentRuntimeType, not this route\'s', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({
      ok: true,
      terminals: [{ id: 'agent-terminal-legacy', name: 'legacy-cli', agentType: 'pagespace-cli', createdAt: new Date('2026-07-01') }],
    });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&projectName=repo&branchName=main'));
    const body = await res.json();
    expect(body.agentTerminals[0]).toEqual({
      id: 'agent-terminal-legacy',
      name: 'legacy-cli',
      agentType: 'pagespace-cli',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('given no view access, returns 403 without listing', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(403);
    expect(mockListAgentTerminals).not.toHaveBeenCalled();
  });

  it('given the branch does not exist, returns 404', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({ ok: false, reason: 'branch_not_found' });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(404);
  });

  it('given no branchName (project scope), lists without error', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({ ok: true, terminals: [] });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&projectName=repo'));
    expect(res.status).toBe(200);
    expect(mockListAgentTerminals).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: 'repo', branchName: undefined }),
    );
  });

  it('given neither projectName nor branchName (machine scope), lists without error', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({ ok: true, terminals: [] });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1'));
    expect(res.status).toBe(200);
    expect(mockListAgentTerminals).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: undefined, branchName: undefined }),
    );
  });

  it('given branchName without projectName, returns 400 (invalid_target) without listing', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({ ok: false, reason: 'invalid_target' });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?machineId=t1&branchName=main'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/machines/agent-terminals', () => {
  function req(body: unknown) {
    return new Request('https://x.test/api/machines/agent-terminals', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }
  const VALID_BODY = { machineId: 't1', projectName: 'repo', branchName: 'main', name: 'cli', agentType: 'shell' };

  it('given no edit access, returns 403 without spawning', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockSpawnAgentTerminal).not.toHaveBeenCalled();
  });

  it('given a fresh spawn of a shell terminal, returns 201 with the row id', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-1', agentType: 'shell', resumed: false });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentTerminal).toMatchObject({ id: 'agent-terminal-1', name: 'cli', agentType: 'shell', resumed: false });
    expect(mockSpawnAgentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: 'repo', branchName: 'main', name: 'cli', agentType: 'shell' }),
    );
  });

  it('given a fresh spawn of a pagespace terminal, returns 201', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-2', agentType: 'pagespace', resumed: false });
    const res = await POST(req({ ...VALID_BODY, name: 'reviewer', agentType: 'pagespace' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentTerminal).toMatchObject({ name: 'reviewer', agentType: 'pagespace', resumed: false });
  });

  it('given a resumed spawn, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-1', agentType: 'shell', resumed: true });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(200);
  });

  it('given an unknown agent type, returns 400', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: false, reason: 'invalid_agent_type' });
    const res = await POST(req({ ...VALID_BODY, agentType: 'gemini' }));
    expect(res.status).toBe(400);
  });

  it('given the name is already used by a different agent type, returns 409', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: false, reason: 'name_in_use' });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('given no such branch, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: false, reason: 'branch_not_found' });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(404);
  });

  it('given a missing agentType, returns 400 without checking access', async () => {
    const { agentType: _omit, ...rest } = VALID_BODY;
    const res = await POST(req(rest));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given a missing name, returns 400', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const res = await POST(req(rest));
    expect(res.status).toBe(400);
  });

  it('given neither projectName nor branchName (machine scope), spawns without error', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-3', agentType: 'shell', resumed: false });
    const { projectName: _p, branchName: _b, ...machineBody } = VALID_BODY;
    const res = await POST(req({ ...machineBody, name: 'shell', agentType: 'shell' }));
    expect(res.status).toBe(201);
    expect(mockSpawnAgentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: undefined, branchName: undefined, name: 'shell', agentType: 'shell' }),
    );
  });

  it('given branchName without projectName, returns 400 (invalid_target)', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: false, reason: 'invalid_target' });
    const { projectName: _omit, ...rest } = VALID_BODY;
    const res = await POST(req(rest));
    expect(res.status).toBe(400);
  });

  it('given an optional command override, passes it through', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-4', agentType: 'shell', resumed: false });
    const res = await POST(req({ ...VALID_BODY, agentType: 'shell', command: 'htop' }));
    expect(res.status).toBe(201);
    expect(mockSpawnAgentTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: 'htop' }));
  });

  it('given an empty-string command, returns 400', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    const res = await POST(req({ ...VALID_BODY, command: '' }));
    expect(res.status).toBe(400);
    expect(mockSpawnAgentTerminal).not.toHaveBeenCalled();
  });

  it('given a pagespace terminal with the code-execution flag off, returns 403 without spawning', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockIsCodeExecutionEnabled.mockReturnValue(false);
    const res = await POST(req({ ...VALID_BODY, agentType: 'pagespace' }));
    expect(res.status).toBe(403);
    expect(mockSpawnAgentTerminal).not.toHaveBeenCalled();
  });

  it('given a pagespace terminal with the code-execution flag on, spawns normally', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockIsCodeExecutionEnabled.mockReturnValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-5', agentType: 'pagespace', resumed: false });
    const res = await POST(req({ ...VALID_BODY, agentType: 'pagespace' }));
    expect(res.status).toBe(201);
    expect(mockSpawnAgentTerminal).toHaveBeenCalled();
  });

  it('given a non-pagespace terminal, spawns regardless of the code-execution flag', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockIsCodeExecutionEnabled.mockReturnValue(false);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-6', agentType: 'shell', resumed: false });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mockSpawnAgentTerminal).toHaveBeenCalled();
  });

  it('given a fresh pagespace spawn, pre-creates the shared conversation keyed on the row id', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-7', agentType: 'pagespace', resumed: false });
    const res = await POST(req({ ...VALID_BODY, agentType: 'pagespace' }));
    expect(res.status).toBe(201);
    expect(mockCreateConversation).toHaveBeenCalledWith('agent-terminal-7', 'user-1', 't1', { isShared: true });
  });

  it('given a resumed pagespace spawn, does NOT pre-create the conversation', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-7', agentType: 'pagespace', resumed: true });
    const res = await POST(req({ ...VALID_BODY, agentType: 'pagespace' }));
    expect(res.status).toBe(200);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it('given a fresh non-pagespace spawn, does NOT pre-create a conversation', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-8', agentType: 'shell', resumed: false });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it('given the pre-create conversation call fails, the spawn still succeeds (non-fatal)', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-9', agentType: 'pagespace', resumed: false });
    mockCreateConversation.mockRejectedValue(new Error('db unavailable'));
    const res = await POST(req({ ...VALID_BODY, agentType: 'pagespace' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentTerminal).toMatchObject({ id: 'agent-terminal-9', resumed: false });
  });
});

describe('DELETE /api/machines/agent-terminals', () => {
  function url(qs: string) {
    return new Request(`https://x.test/api/machines/agent-terminals?${qs}`, { method: 'DELETE' });
  }

  it('given no edit access, returns 403 without killing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(url('machineId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(403);
    expect(mockKillAgentTerminal).not.toHaveBeenCalled();
  });

  it('given the agent terminal does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(url('machineId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(404);
  });

  it('given a successful kill, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: true });
    const res = await DELETE(url('machineId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(200);
    expect(mockKillAgentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: 'repo', branchName: 'main', name: 'cli' }),
    );
  });

  it('given no name, returns 400', async () => {
    const res = await DELETE(url('machineId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(400);
  });

  it('given neither projectName nor branchName (machine scope), kills without error and passes the actor to buildKillAgentTerminalDeps', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: true });
    const res = await DELETE(url('machineId=t1&name=shell'));
    expect(res.status).toBe(200);
    expect(mockKillAgentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 't1', projectName: undefined, branchName: undefined, name: 'shell' }),
    );
    expect(mockBuildKillAgentTerminalDeps).toHaveBeenCalledWith('user-1');
  });

  it('given branchName without projectName, returns 400 (invalid_target)', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: false, reason: 'invalid_target' });
    const res = await DELETE(url('machineId=t1&branchName=main&name=cli'));
    expect(res.status).toBe(400);
  });

  it('given a chat-surface (not_a_pty_agent) row, returns a pinned status', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: false, reason: 'not_a_pty_agent' });
    const res = await DELETE(url('machineId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(409);
  });
});
