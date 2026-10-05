/**
 * Unit tests for GET /api/user/builtin-agents — the viewer's Imago agent
 * pointers. The real-database behaviour (real session cookie, real
 * provisioning, cross-user isolation) is in route.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { rows, where, insert, update, deleteFn } = vi.hoisted(() => {
  const rows: { value: unknown[] } = { value: [] };
  return {
    rows,
    where: vi.fn(() => Promise.resolve(rows.value)),
    insert: vi.fn(),
    update: vi.fn(),
    deleteFn: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where })) })) })),
    insert,
    update,
    delete: deleteFn,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
}));
vi.mock('@pagespace/db/schema/user-builtin-agents', () => ({
  userBuiltinAgents: { userId: 'uba.userId', key: 'uba.key', pageId: 'uba.pageId' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', isTrashed: 'pages.isTrashed' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { eq } from '@pagespace/db/operators';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { BUILTIN_AGENTS } from '@pagespace/lib/agents/builtin-agents';

const VIEWER = 'user_viewer';

function signedIn() {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: VIEWER,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
}

async function readAgents(response: Response) {
  const body = (await response.json()) as { agents: Array<Record<string, unknown>> };
  return body.agents;
}

describe('GET /api/user/builtin-agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.value = [];
    signedIn();
  });

  it('given no session, should return the 401 from authentication and touch no data', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    });

    const response = await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(response.status).toBe(401);
    expect(where).not.toHaveBeenCalled();
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('should accept session authentication only', async () => {
    await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'] });
  });

  it('given a fully provisioned viewer, should return every registry key with its page id and registry title', async () => {
    rows.value = [
      { key: 'imago', pageId: 'page_imago', isTrashed: false },
      { key: 'imago-planner', pageId: 'page_planner', isTrashed: false },
      { key: 'imago-researcher', pageId: 'page_researcher', isTrashed: false },
    ];

    const response = await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(response.status).toBe(200);
    expect(await readAgents(response)).toEqual([
      { key: 'imago', pageId: 'page_imago', title: 'Imago' },
      { key: 'imago-planner', pageId: 'page_planner', title: 'Imago Planner' },
      { key: 'imago-researcher', pageId: 'page_researcher', title: 'Imago Researcher' },
    ]);
  });

  it('given a viewer with no pointers, should return every registry key with pageId null', async () => {
    const response = await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(await readAgents(response)).toEqual(
      BUILTIN_AGENTS.map((agent) => ({ key: agent.key, pageId: null, title: agent.title })),
    );
  });

  it('given a pointer whose page is trashed, should report that key as not provisioned', async () => {
    rows.value = [
      { key: 'imago', pageId: 'page_imago', isTrashed: true },
      { key: 'imago-planner', pageId: 'page_planner', isTrashed: false },
    ];

    const agents = await readAgents(await GET(new Request('http://localhost/api/user/builtin-agents')));

    expect(agents.find((agent) => agent.key === 'imago')?.pageId).toBeNull();
    expect(agents.find((agent) => agent.key === 'imago-planner')?.pageId).toBe('page_planner');
  });

  it('given a stored key the registry no longer defines, should leave it out', async () => {
    rows.value = [{ key: 'retired-agent', pageId: 'page_retired', isTrashed: false }];

    const agents = await readAgents(await GET(new Request('http://localhost/api/user/builtin-agents')));

    expect(agents.map((agent) => agent.key)).toEqual(['imago', 'imago-planner', 'imago-researcher']);
    expect(agents.every((agent) => agent.pageId === null)).toBe(true);
  });

  it('should return only key, pageId and title — never system prompts or tool lists', async () => {
    const agents = await readAgents(await GET(new Request('http://localhost/api/user/builtin-agents')));

    for (const agent of agents) {
      expect(Object.keys(agent).sort()).toEqual(['key', 'pageId', 'title']);
    }
  });

  it("given another user's id in the query, headers or body, should still read only the viewer's pointers", async () => {
    const request = new Request('http://localhost/api/user/builtin-agents?userId=user_other&id=user_other', {
      headers: { 'x-user-id': 'user_other' },
    });

    await GET(request);

    expect(eq).toHaveBeenCalledTimes(2);
    expect(eq).toHaveBeenCalledWith('uba.userId', VIEWER);
    expect(eq).not.toHaveBeenCalledWith(expect.anything(), 'user_other');
  });

  it('should write nothing', async () => {
    await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('should audit the read against the viewer', async () => {
    await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), {
      eventType: 'data.read',
      userId: VIEWER,
      resourceType: 'builtin_agents',
      resourceId: 'self',
    });
  });

  it('given a database failure, should return 500 without leaking the error', async () => {
    where.mockRejectedValueOnce(new Error('connection reset by peer at 10.0.0.1'));

    const response = await GET(new Request('http://localhost/api/user/builtin-agents'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch built-in agents' });
  });
});
