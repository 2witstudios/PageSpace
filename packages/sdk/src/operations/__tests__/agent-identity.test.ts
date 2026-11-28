/**
 * The agent-identity operations (ADR 0008; Agent Signup Phase 5): an AI agent
 * creating and funding its own PageSpace account. The wire shapes are pinned
 * to the routes and to `/auth.md` (apps/web/src/lib/agent-auth/auth-md.ts):
 * Prove work → Register → Fund → Rotate.
 */
import { describe, expect, it, vi } from 'vitest';
import { claimAgent, getAgentChallenge, rotateAgentSecret, signUpAgent } from '../agent-identity.js';
import { PageSpaceClient } from '../../client.js';
import { AnonymousAuthProvider } from '../../auth/anonymous.js';
import type { AuthProvider } from '../../auth/provider.js';

const CHALLENGE_RESPONSE = {
  challenge: 'ps_pow_abc',
  difficulty_bits: 20,
  expires_in: 300,
  algorithm: 'sha3-256',
  input: 'ps_pow_abc:<nonce>',
};

const IDENTITY_RESPONSE = {
  identity_assertion: 'ps_agent_abcdefghijklmnopqrstuvwxyz012345',
  agent_id: 'agent_1',
  account_type: 'agent',
  token_endpoint: 'https://pagespace.ai/api/oauth/token',
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  client_id: 'pagespace-agent',
  claim_endpoint: 'https://pagespace.ai/api/agent/claim',
};

const CLAIM_RESPONSE = {
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://pagespace.ai/claim',
  verification_uri_complete: 'https://pagespace.ai/claim?user_code=ABCD-EFGH',
  expires_in: 900,
  interval: 5,
};

describe('agent.challenge', () => {
  it('is an unauthenticated GET of the proof-of-work challenge with no input', () => {
    expect(getAgentChallenge.name).toBe('agent.challenge');
    expect(getAgentChallenge.method).toBe('GET');
    expect(getAgentChallenge.path).toBe('/api/agent/challenge');
    expect(getAgentChallenge.unauthenticated).toBe(true);
    expect(getAgentChallenge.inputSchema.safeParse({}).success).toBe(true);
  });

  it('parses the challenge body', () => {
    const parsed = getAgentChallenge.outputSchema.safeParse(CHALLENGE_RESPONSE);
    expect(parsed.success).toBe(true);
  });

  it('refuses a challenge whose difficulty is outside 1..64 (a solver would never finish)', () => {
    expect(getAgentChallenge.outputSchema.safeParse({ ...CHALLENGE_RESPONSE, difficulty_bits: 0 }).success).toBe(false);
    expect(getAgentChallenge.outputSchema.safeParse({ ...CHALLENGE_RESPONSE, difficulty_bits: 65 }).success).toBe(false);
  });
});

describe('agent.signup', () => {
  const valid = { type: 'anonymous', tos_accepted: true, pow: { challenge: 'ps_pow_abc', nonce: '42' } } as const;

  it('is an unauthenticated POST to the identity endpoint', () => {
    expect(signUpAgent.name).toBe('agent.signup');
    expect(signUpAgent.method).toBe('POST');
    expect(signUpAgent.path).toBe('/api/agent/identity');
    expect(signUpAgent.unauthenticated).toBe(true);
  });

  it('accepts the auth.md registration body with optional name and source', () => {
    expect(signUpAgent.inputSchema.safeParse(valid).success).toBe(true);
    expect(signUpAgent.inputSchema.safeParse({ ...valid, name: 'Claude', source: 'claude-code' }).success).toBe(true);
  });

  it('is strict at every level: an unknown field, also inside pow, is refused', () => {
    expect(signUpAgent.inputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(signUpAgent.inputSchema.safeParse({ ...valid, pow: { ...valid.pow, extra: 1 } }).success).toBe(false);
  });

  it('enforces the server bounds so a bad name fails before a proof-of-work is wasted', () => {
    expect(signUpAgent.inputSchema.safeParse({ ...valid, name: 'x'.repeat(81) }).success).toBe(false);
    expect(signUpAgent.inputSchema.safeParse({ ...valid, source: 'x'.repeat(121) }).success).toBe(false);
    expect(signUpAgent.inputSchema.safeParse({ ...valid, type: 'verified' }).success).toBe(false);
    expect(signUpAgent.inputSchema.safeParse({ ...valid, pow: { challenge: 'c', nonce: 'n'.repeat(65) } }).success).toBe(false);
  });

  it('parses the one-time identity response, and only an agent account', () => {
    expect(signUpAgent.outputSchema.safeParse(IDENTITY_RESPONSE).success).toBe(true);
    expect(signUpAgent.outputSchema.safeParse({ ...IDENTITY_RESPONSE, account_type: 'human' }).success).toBe(false);
  });
});

describe('agent.claim', () => {
  // Security review: the claim token was an agent-takeover credential and is
  // gone. A claim is started with the agent's OWN access token.
  it("is an AUTHENTICATED POST that takes no input — the agent's own account token is the credential", () => {
    expect(claimAgent.name).toBe('agent.claim');
    expect(claimAgent.method).toBe('POST');
    expect(claimAgent.path).toBe('/api/agent/claim');
    expect(claimAgent.unauthenticated).toBeUndefined();
    expect(claimAgent.requiredScope).toBe('account');
    expect(claimAgent.inputSchema.safeParse({}).success).toBe(true);
    expect(claimAgent.inputSchema.safeParse({ claim_token: 'ps_claim_xyz' }).success).toBe(false);
  });

  it('parses the user code, both verification URIs, expiry and poll interval', () => {
    const parsed = claimAgent.outputSchema.safeParse(CLAIM_RESPONSE);
    expect(parsed.success && parsed.data).toEqual(CLAIM_RESPONSE);
  });
});

describe('agent.rotateSecret', () => {
  it('is an authenticated POST to the rotate endpoint', () => {
    expect(rotateAgentSecret.name).toBe('agent.rotateSecret');
    expect(rotateAgentSecret.method).toBe('POST');
    expect(rotateAgentSecret.path).toBe('/api/agent/secret/rotate');
    expect(rotateAgentSecret.unauthenticated).toBeUndefined();
    expect(rotateAgentSecret.requiredScope).toBe('account');
  });

  it('takes an optional revokeExistingTokens and an optional agentId (an owner naming its agent)', () => {
    expect(rotateAgentSecret.inputSchema.safeParse({}).success).toBe(true);
    expect(rotateAgentSecret.inputSchema.safeParse({ revokeExistingTokens: true }).success).toBe(true);
    expect(rotateAgentSecret.inputSchema.safeParse({ agentId: 'agent_1' }).success).toBe(true);
    expect(rotateAgentSecret.inputSchema.safeParse({ revokeExistingTokens: 'yes' }).success).toBe(false);
  });

  it('parses the new one-time secret', () => {
    const parsed = rotateAgentSecret.outputSchema.safeParse({
      identity_assertion: 'ps_agent_new',
      agent_id: 'agent_1',
      secret_version: 2,
      revoked_existing_tokens: false,
    });
    expect(parsed.success).toBe(true);
  });
});

function versioned(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'X-PageSpace-API-Version': '1.0.0' } });
}

describe('client.agent — through the facade', () => {
  it('calls an unauthenticated operation without asking the provider for a token or sending Authorization', async () => {
    const getAccessToken = vi.fn(async () => 'should-not-be-used');
    const auth: AuthProvider = { getAccessToken, invalidate: vi.fn() };
    const fetchImpl = vi.fn(async () => versioned(CHALLENGE_RESPONSE));
    const client = new PageSpaceClient({ baseUrl: 'https://pagespace.ai', auth, fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.agent.challenge({})).resolves.toEqual(CHALLENGE_RESPONSE);

    expect(getAccessToken).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pagespace.ai/api/agent/challenge');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('works with AnonymousAuthProvider — an agent with no credential yet can sign up', async () => {
    const fetchImpl = vi.fn(async () => versioned(IDENTITY_RESPONSE));
    const client = new PageSpaceClient({
      baseUrl: 'https://pagespace.ai',
      auth: new AnonymousAuthProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.agent.signup({ type: 'anonymous', tos_accepted: true, pow: { challenge: 'c', nonce: '1' } });

    expect(result.identity_assertion).toBe(IDENTITY_RESPONSE.identity_assertion);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ pow: { challenge: 'c', nonce: '1' }, tos_accepted: true, type: 'anonymous' });
  });

  it('still authenticates rotateSecret: AnonymousAuthProvider refuses it before any request', async () => {
    const fetchImpl = vi.fn(async () => versioned({}));
    const client = new PageSpaceClient({
      baseUrl: 'https://pagespace.ai',
      auth: new AnonymousAuthProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.agent.rotateSecret({})).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still authenticates claim: AnonymousAuthProvider refuses it before any request', async () => {
    const fetchImpl = vi.fn(async () => versioned(CLAIM_RESPONSE));
    const client = new PageSpaceClient({ baseUrl: 'https://pagespace.ai', auth: new AnonymousAuthProvider(), fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.agent.claim({})).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the agent's own bearer on claim, and no claim token", async () => {
    const fetchImpl = vi.fn(async () => versioned(CLAIM_RESPONSE));
    const auth: AuthProvider = { getAccessToken: async () => 'ps_at_agent', invalidate: () => {} };
    const client = new PageSpaceClient({ baseUrl: 'https://pagespace.ai', auth, fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.agent.claim({})).resolves.toEqual(CLAIM_RESPONSE);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pagespace.ai/api/agent/claim');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ps_at_agent');
    expect(String(init.body ?? '')).not.toContain('claim_token');
  });

  it('sends the bearer on rotateSecret', async () => {
    const fetchImpl = vi.fn(async () =>
      versioned({ identity_assertion: 'ps_agent_new', agent_id: 'a', secret_version: 2, revoked_existing_tokens: true }),
    );
    const auth: AuthProvider = { getAccessToken: async () => 'ps_at_agent', invalidate: () => {} };
    const client = new PageSpaceClient({ baseUrl: 'https://pagespace.ai', auth, fetch: fetchImpl as unknown as typeof fetch });

    await client.agent.rotateSecret({ revokeExistingTokens: true });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ps_at_agent');
  });
});
