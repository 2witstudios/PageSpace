import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';

const authenticateRequestWithOptions = vi.fn();
const resolveAgentModel = vi.fn();

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) =>
    authenticateRequestWithOptions(...args),
  isAuthError: (r: unknown) => !!r && typeof r === 'object' && 'error' in r,
}));
vi.mock('../model-resolver', () => ({
  resolveAgentModel: (...args: unknown[]) => resolveAgentModel(...args),
}));

import { resolveInferenceContext } from '../context-resolver';

const request = new Request('http://localhost/api/v1/chat/completions', {
  method: 'POST',
});
const agentPage = { id: 'p1', title: 'Agent', type: 'AI_CHAT', driveId: 'd1' };

describe('resolveInferenceContext', () => {
  beforeEach(() => {
    authenticateRequestWithOptions.mockReset();
    resolveAgentModel.mockReset();
  });

  test('request without a valid MCP token', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: {} });

    const result = await resolveInferenceContext(request, 'ps-agent://p1');

    assert({
      given: 'a request whose MCP authentication fails',
      should: 'deny it as unauthorized in OpenAI error shape',
      actual: { ok: result.ok, status: result.ok ? null : result.status },
      expected: { ok: false, status: 401 },
    });
  });

  test('token scoped to drives excluding the agent drive', async () => {
    authenticateRequestWithOptions.mockResolvedValue({
      tokenType: 'mcp',
      userId: 'u1',
      allowedDriveIds: ['other-drive'],
    });
    resolveAgentModel.mockResolvedValue({ ok: true, pageId: 'p1', page: agentPage });

    const result = await resolveInferenceContext(request, 'ps-agent://p1');

    assert({
      given: "an MCP token scoped to drives that exclude the agent's drive",
      should: 'deny it as forbidden',
      actual: { ok: result.ok, status: result.ok ? null : result.status },
      expected: { ok: false, status: 403 },
    });
  });

  test('valid in-scope token with a resolvable agent', async () => {
    authenticateRequestWithOptions.mockResolvedValue({
      tokenType: 'mcp',
      userId: 'u1',
      allowedDriveIds: [],
    });
    resolveAgentModel.mockResolvedValue({ ok: true, pageId: 'p1', page: agentPage });

    const result = await resolveInferenceContext(request, 'ps-agent://p1');

    assert({
      given: 'a valid in-scope MCP token and a resolvable agent',
      should: 'return a context carrying the agent page and authenticated user',
      actual: result.ok
        ? { userId: result.context.userId, pageId: result.context.pageId, page: result.context.page }
        : result,
      expected: { userId: 'u1', pageId: 'p1', page: agentPage },
    });
  });

  test('unresolvable model on an authenticated request', async () => {
    authenticateRequestWithOptions.mockResolvedValue({
      tokenType: 'mcp',
      userId: 'u1',
      allowedDriveIds: [],
    });
    resolveAgentModel.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'model_not_found',
      message: 'nope',
    });

    const result = await resolveInferenceContext(request, 'ps-agent://ghost');

    assert({
      given: 'an authenticated request whose model does not resolve',
      should: 'surface the resolver status as an OpenAI error',
      actual: { ok: result.ok, status: result.ok ? null : result.status },
      expected: { ok: false, status: 404 },
    });
  });
});
