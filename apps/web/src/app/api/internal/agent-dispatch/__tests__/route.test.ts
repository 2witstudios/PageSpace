import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatSignatureHeader,
  generateBroadcastSignature,
} from '@pagespace/lib/auth/broadcast-auth';
import {
  signAgentDispatch,
  type AgentDispatchPayload,
} from '@pagespace/lib/auth/agent-dispatch-payload';
import { loadServicePrincipal } from '@/lib/auth';
import { dispatchChatTurn } from '@/lib/ai/chat-pipeline/handle-chat-turn';
import { POST } from '../route';

vi.mock('@pagespace/lib/logging/logger-config', () => {
  const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { loggers: { ai: silent, auth: silent }, logSecurityEvent: vi.fn() };
});
vi.mock('@/lib/auth', () => ({ loadServicePrincipal: vi.fn() }));
vi.mock('@/lib/ai/chat-pipeline/handle-chat-turn', () => ({ dispatchChatTurn: vi.fn() }));

const loadServicePrincipalMock = vi.mocked(loadServicePrincipal);
const dispatchChatTurnMock = vi.mocked(dispatchChatTurn);

const PAYLOAD: AgentDispatchPayload = {
  v: 1,
  actingUserId: 'user-1',
  conversationId: 'worker-conversation-1',
  chatId: 'agent-page-1',
  depth: 2,
  allowedDriveIds: ['drive-a'],
  originatingMcpTokenId: 'mcp-token-1',
  browserSessionId: 'agent-dispatch-abc',
  messageId: 'message-1',
  text: 'hello',
};

const PRINCIPAL = {
  tokenType: 'service' as const,
  service: 'agent-dispatch' as const,
  userId: 'user-1',
  role: 'user' as const,
  tokenVersion: 1,
  adminRoleVersion: 1,
  allowedDriveIds: ['drive-a'],
  originatingMcpTokenId: 'mcp-token-1',
};

function request(body: string, signatureHeader?: string): Request {
  return new Request('http://localhost:3000/api/internal/agent-dispatch', {
    method: 'POST',
    headers: signatureHeader ? { 'x-broadcast-signature': signatureHeader } : {},
    body,
  });
}

function signed(payload: AgentDispatchPayload = PAYLOAD): Request {
  const { body, signatureHeader } = signAgentDispatch(payload);
  return request(body, signatureHeader);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('REALTIME_BROADCAST_SECRET', 'test-broadcast-secret-at-least-32-chars');
  loadServicePrincipalMock.mockResolvedValue(PRINCIPAL);
  dispatchChatTurnMock.mockResolvedValue(new Response('ok', { status: 200 }));
});

describe('POST /api/internal/agent-dispatch', () => {
  it('refuses an unsigned request', async () => {
    const response = await POST(request(JSON.stringify(PAYLOAD)));

    expect(response.status).toBe(401);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('refuses a body that was tampered with after signing', async () => {
    const { body, signatureHeader } = signAgentDispatch(PAYLOAD);
    const tampered = body.replace('"user-1"', '"victim-user"');
    expect(tampered).not.toBe(body);

    const response = await POST(request(tampered, signatureHeader));

    expect(response.status).toBe(401);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('refuses a signature outside the timestamp window', async () => {
    // Signed with a real HMAC, six minutes ago — past the 5-minute window every
    // other signed internal hop enforces.
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    const body = JSON.stringify(PAYLOAD);
    const { signature } = generateBroadcastSignature(body, stale);

    const response = await POST(request(body, formatSignatureHeader(stale, signature)));

    expect(response.status).toBe(401);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('refuses a signed body that is not a dispatch payload', async () => {
    const body = JSON.stringify({ v: 1, actingUserId: 'user-1' });
    const { timestamp, signature } = generateBroadcastSignature(body);

    const response = await POST(request(body, formatSignatureHeader(timestamp, signature)));

    expect(response.status).toBe(401);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('refuses when the acting user cannot be resolved (unknown or suspended)', async () => {
    // `loadServicePrincipal` collapses both into `null` on purpose — a caller
    // that can sign still learns nothing about which users exist.
    loadServicePrincipalMock.mockResolvedValue(null);

    const response = await POST(signed());

    expect(response.status).toBe(401);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('runs the turn as the user named in the signed payload', async () => {
    await POST(signed());

    expect(loadServicePrincipalMock).toHaveBeenCalledWith({
      userId: 'user-1',
      service: 'agent-dispatch',
      allowedDriveIds: ['drive-a'],
      originatingMcpTokenId: 'mcp-token-1',
    });
    const turn = dispatchChatTurnMock.mock.calls[0][0];
    expect(turn.auth).toBe(PRINCIPAL);
    expect(turn.browserSessionId).toBe('agent-dispatch-abc');
    expect(turn.body.conversationId).toBe('worker-conversation-1');
    expect(turn.body.chatId).toBe('agent-page-1');
  });

  it('takes the depth from the SIGNED payload, not the wire header', async () => {
    // The cap is the termination condition of a recursive system. A forged
    // header claiming depth 0 must not reset a chain that is really at 2.
    const { body, signatureHeader } = signAgentDispatch(PAYLOAD);
    const forged = new Request('http://localhost:3000/api/internal/agent-dispatch', {
      method: 'POST',
      headers: {
        'x-broadcast-signature': signatureHeader,
        'X-Agent-Dispatch-Depth': '0',
      },
      body,
    });

    await POST(forged);

    const turn = dispatchChatTurnMock.mock.calls[0][0];
    expect(turn.request.headers.get('X-Agent-Dispatch-Depth')).toBe('2');
  });

  it('omits chatId entirely for a global-assistant worker', async () => {
    // The strategy selection distinguishes "no chatId" from "chatId: null"; a
    // null would fall through to the page strategy's "chatId is required" 400.
    await POST(signed({ ...PAYLOAD, chatId: null }));

    const turn = dispatchChatTurnMock.mock.calls[0][0];
    expect(turn.body).not.toHaveProperty('chatId');
    expect(turn.body.conversationId).toBe('worker-conversation-1');
  });
});
