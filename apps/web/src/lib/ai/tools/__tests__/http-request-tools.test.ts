/**
 * L2·G2 — the `http_request` tool wrapper. It turns the tool call and the run
 * context into the authority's caller and returns `toHttpRequestToolResult`.
 * Pinned: the model supplies only an account id and the request — the acting
 * human, session, agent page, run and caller ceiling come from the RUN
 * context; an agent-to-agent call is unattended (no session); the result
 * carries the account id and never a value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthority = vi.hoisted(() => ({ requestOperation: vi.fn(), listAccounts: vi.fn() }));
const mockGetAuthority = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent-accounts/account-authority-client', () => ({ getAccountAuthority: mockGetAuthority }));

import { httpRequestTools } from '../http-request-tools';
import type { ToolExecutionContext } from '../../core/types';

const execute = (input: Record<string, unknown>, context: Partial<ToolExecutionContext>) =>
  (httpRequestTools.http_request as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(input, { experimental_context: context, toolCallId: 't1', messages: [] });

const released = { status: 200, headers: [['content-type', 'application/json']], body: '{"temp":7}', bodyOmitted: null, truncated: false, redacted: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthority.mockReturnValue(mockAuthority);
  mockAuthority.requestOperation.mockResolvedValue({ ok: true, response: released });
});

describe('http_request tool', () => {
  it('given a person driving an agent page, should call the authority as that person with their session, the page, the run and their ceiling', async () => {
    const context: Partial<ToolExecutionContext> = { userId: 'user_1', authSessionId: 'sess_1', conversationId: 'conv_1', chatSource: { type: 'page', agentPageId: 'page_a' }, mcpAllowedDriveIds: ['drive_1'], mcpTokenId: 'mcp_1' };
    const result = await execute({ accountId: 'acct_1', method: 'GET', url: 'https://api.weather.example/v1/x' }, context);
    const call = mockAuthority.requestOperation.mock.calls[0]?.[0];
    const actual = {
      caller: { ...call.caller, runId: typeof call.caller.runId === 'string' },
      accountId: call.accountId,
      request: { ...call.request, body: Array.from(call.request.body as Uint8Array) },
      result,
    };
    const expected = {
      caller: { actorUserId: 'user_1', actingHumanUserId: 'user_1', sessionId: 'sess_1', agentPageId: 'page_a', conversationId: 'conv_1', runId: true, callerCeiling: { allowedDriveIds: ['drive_1'], originatingMcpTokenId: 'mcp_1' } },
      accountId: 'acct_1',
      request: { channel: 'http-executor', method: 'GET', url: 'https://api.weather.example/v1/x', headers: {}, body: [] },
      result: { ok: true, accountId: 'acct_1', status: 200, headers: { 'content-type': 'application/json' }, body: '{"temp":7}', bodyOmitted: null, truncated: false, redacted: false },
    };
    expect(actual).toEqual(expected);
  });

  it('given an agent-to-agent run, should present no live session (unattended), whatever session id the context carries', async () => {
    await execute({ accountId: 'acct_1', method: 'GET', url: 'https://api.weather.example/v1/x' }, { userId: 'user_1', authSessionId: 'sess_1', requestOrigin: 'agent', chatSource: { type: 'global' } });
    const actual = mockAuthority.requestOperation.mock.calls[0]?.[0]?.caller?.sessionId;
    const expected = null;
    expect(actual).toEqual(expected);
  });

  it('given the credential plane not configured, should answer account_unavailable without calling anything', async () => {
    mockGetAuthority.mockReturnValue(null);
    const result = await execute({ accountId: 'acct_1', method: 'GET', url: 'https://x.example/' }, { userId: 'user_1' });
    const actual = { error: (result as { error?: string }).error, called: mockAuthority.requestOperation.mock.calls.length };
    const expected = { error: 'account_unavailable', called: 0 };
    expect(actual).toEqual(expected);
  });

  it('given a body, should hand its exact UTF-8 bytes to the authority', async () => {
    await execute({ accountId: 'acct_1', method: 'POST', url: 'https://api.weather.example/v1/q', headers: { 'content-type': 'application/json' }, body: '{"q":"ø"}' }, { userId: 'user_1', authSessionId: 's' });
    const actual = new TextDecoder().decode(mockAuthority.requestOperation.mock.calls[0]?.[0]?.request?.body as Uint8Array);
    const expected = '{"q":"ø"}';
    expect(actual).toEqual(expected);
  });
});

const listAccounts = (context: Partial<ToolExecutionContext>) =>
  (httpRequestTools.list_accounts as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute({}, { experimental_context: context, toolCallId: 't2', messages: [] });

const account = (overrides: Record<string, unknown>) => ({ id: 'acct_1', kind: 'api_key', name: 'Weather', ownerKind: 'agent_page', providerSlug: null, allowedOrigins: ['https://api.weather.example:443'], acknowledgment: 'dedicated_agent_account', status: 'active', upstreamRevocation: null, lastUsedAt: null, createdAt: 1, revokedAt: null, ready: true, ...overrides });

describe('list_accounts tool (Codex P1: the model needs account ids)', () => {
  it('given an agent page run, should list that page’s active accounts by id, name and site — nothing else', async () => {
    mockAuthority.listAccounts.mockResolvedValue([account({}), account({ id: 'acct_2', name: 'Old', status: 'revoked' }), account({ id: 'acct_3', name: 'Pending', ready: false })]);
    const result = await listAccounts({ userId: 'user_1', chatSource: { type: 'page', agentPageId: 'page_a' } });
    const actual = { result, call: mockAuthority.listAccounts.mock.calls[0]?.[0] };
    const expected = {
      result: { accounts: [{ accountId: 'acct_1', name: 'Weather', sites: ['https://api.weather.example'], ready: true }, { accountId: 'acct_3', name: 'Pending', sites: ['https://api.weather.example'], ready: false }] },
      call: { actorUserId: 'user_1', owner: { kind: 'agent_page', agentPageId: 'page_a' } },
    };
    expect(actual).toEqual(expected);
  });

  it('given the global assistant, should list the person’s own accounts', async () => {
    mockAuthority.listAccounts.mockResolvedValue([]);
    await listAccounts({ userId: 'user_1', chatSource: { type: 'global' } });
    const actual = mockAuthority.listAccounts.mock.calls[0]?.[0]?.owner;
    const expected = { kind: 'user' };
    expect(actual).toEqual(expected);
  });

  it('given a caller who may not see the page’s accounts, or no configuration, should list none', async () => {
    mockAuthority.listAccounts.mockResolvedValue(null);
    const denied = await listAccounts({ userId: 'user_1', chatSource: { type: 'page', agentPageId: 'page_a' } });
    mockGetAuthority.mockReturnValue(null);
    const unconfigured = await listAccounts({ userId: 'user_1' });
    const actual = [denied, unconfigured];
    const expected = [{ accounts: [] }, { accounts: [] }];
    expect(actual).toEqual(expected);
  });
});

