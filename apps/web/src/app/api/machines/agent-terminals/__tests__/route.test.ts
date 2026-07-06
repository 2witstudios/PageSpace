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
  mockSpawnAgentTerminal,
  mockKillAgentTerminal,
  mockListAgentTerminals,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockBuildSpawnAgentTerminalDeps: vi.fn(),
  mockBuildKillAgentTerminalDeps: vi.fn(),
  mockBuildListAgentTerminalsDeps: vi.fn(),
  mockSpawnAgentTerminal: vi.fn(),
  mockKillAgentTerminal: vi.fn(),
  mockListAgentTerminals: vi.fn(),
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
}));

vi.mock('@pagespace/lib/services/machines/agent-terminals', () => ({
  spawnAgentTerminal: (...args: unknown[]) => mockSpawnAgentTerminal(...args),
  killAgentTerminal: (...args: unknown[]) => mockKillAgentTerminal(...args),
  listAgentTerminals: (...args: unknown[]) => mockListAgentTerminals(...args),
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
});

describe('GET /api/machines/agent-terminals', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?terminalId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(401);
  });

  it('given view access, lists the branch agent terminals', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({
      ok: true,
      terminals: [{ name: 'cli', agentType: 'pagespace-cli', createdAt: new Date('2026-07-01') }],
    });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?terminalId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentTerminals).toHaveLength(1);
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', 't1');
    expect(mockListAgentTerminals).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1', projectName: 'repo', branchName: 'main' }),
    );
  });

  it('given no view access, returns 403 without listing', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?terminalId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(403);
    expect(mockListAgentTerminals).not.toHaveBeenCalled();
  });

  it('given the branch does not exist, returns 404', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockListAgentTerminals.mockResolvedValue({ ok: false, reason: 'branch_not_found' });
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?terminalId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(404);
  });

  it('given no branchName, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/agent-terminals?terminalId=t1&projectName=repo'));
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
  const VALID_BODY = { terminalId: 't1', projectName: 'repo', branchName: 'main', name: 'cli', agentType: 'pagespace-cli' };

  it('given no edit access, returns 403 without spawning', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockSpawnAgentTerminal).not.toHaveBeenCalled();
  });

  it('given a fresh spawn of a pagespace-cli terminal, returns 201', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-1', agentType: 'pagespace-cli', resumed: false });
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentTerminal).toMatchObject({ name: 'cli', agentType: 'pagespace-cli', resumed: false });
    expect(mockSpawnAgentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1', projectName: 'repo', branchName: 'main', name: 'cli', agentType: 'pagespace-cli' }),
    );
  });

  it('given a fresh spawn of a claude terminal, returns 201', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-2', agentType: 'claude', resumed: false });
    const res = await POST(req({ ...VALID_BODY, name: 'reviewer', agentType: 'claude' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentTerminal).toMatchObject({ name: 'reviewer', agentType: 'claude', resumed: false });
  });

  it('given a resumed spawn, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockSpawnAgentTerminal.mockResolvedValue({ ok: true, id: 'agent-terminal-1', agentType: 'pagespace-cli', resumed: true });
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
});

describe('DELETE /api/machines/agent-terminals', () => {
  function url(qs: string) {
    return new Request(`https://x.test/api/machines/agent-terminals?${qs}`, { method: 'DELETE' });
  }

  it('given no edit access, returns 403 without killing', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(url('terminalId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(403);
    expect(mockKillAgentTerminal).not.toHaveBeenCalled();
  });

  it('given the agent terminal does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(url('terminalId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(404);
  });

  it('given a successful kill, returns 200', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockKillAgentTerminal.mockResolvedValue({ ok: true });
    const res = await DELETE(url('terminalId=t1&projectName=repo&branchName=main&name=cli'));
    expect(res.status).toBe(200);
    expect(mockKillAgentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1', projectName: 'repo', branchName: 'main', name: 'cli' }),
    );
  });

  it('given no name, returns 400', async () => {
    const res = await DELETE(url('terminalId=t1&projectName=repo&branchName=main'));
    expect(res.status).toBe(400);
  });
});
