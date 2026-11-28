/**
 * The agent-account commands (ADR 0008; Agent Signup Phase 5): an AI agent
 * creating its own account and ending up able to run content commands and
 * `pagespace mcp` with zero human steps. Every network edge is injected;
 * `ctx.sdk` is a fake exposing only the `agent.*` operations a command calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PermissionDeniedError, ValidationError } from '@pagespace/sdk';
import type { OAuthTokens } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, helpHandler, parseArgv } from '@pagespace/cli';
import type { AgentHostCredential, CredentialStore, HostCredential, OAuthHostCredential } from '@pagespace/cli';
import { createFakeActiveKeyStore, createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import {
  createAgentClaimHandler,
  createAgentCreateKeyHandler,
  createAgentLoginHandler,
  createAgentRotateSecretHandler,
  createSignupHandler,
  DEFAULT_AGENT_SOURCE,
  PAGESPACE_TERMS_URL,
  type AgentCommandDeps,
} from '../agent.js';
import { createMcpHandler } from '../mcp.js';
import { createLogoutHandler } from '../logout.js';
import { createWhoamiHandler } from '../whoami.js';
import type { AgentClaimPollResult } from '../../auth/poll-agent-claim.js';

const HOST = 'https://pagespace.ai';
const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';
const NEW_SECRET = 'ps_agent_zyxwvutsrqponmlkjihgfedcba543210';
const TOKEN_ENDPOINT = `${HOST}/api/oauth/token`;

const tokens = (tag: string): OAuthTokens => ({
  accessToken: `ps_at_${tag}`,
  accessExpiresAt: 10_000,
  refreshToken: `ps_rt_${tag}`,
  refreshExpiresAt: 99_000,
  scope: 'account offline_access',
});

const IDENTITY = {
  identity_assertion: SECRET,
  agent_id: 'agent_1',
  claim_token: 'ps_claim_1',
  account_type: 'agent' as const,
  token_endpoint: TOKEN_ENDPOINT,
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  client_id: 'pagespace-agent',
  claim_endpoint: `${HOST}/api/agent/claim`,
};

const CHALLENGE = { challenge: 'ps_pow_c1', difficulty_bits: 4, expires_in: 300, algorithm: 'sha3-256' as const, input: 'ps_pow_c1:<nonce>' };

/** Profile-aware in-memory store that records the order of writes. */
function profileStore(initial: Record<string, HostCredential> = {}) {
  const data = new Map<string, HostCredential>(Object.entries(initial).map(([profile, credential]) => [`${HOST}|${profile}`, credential]));
  const writes: Array<{ profile: string; credential: HostCredential }> = [];
  const store: CredentialStore & { writes: typeof writes; read: (profile: string) => HostCredential | undefined } = {
    writes,
    read: (profile) => data.get(`${HOST}|${profile}`),
    async get(host, profile = 'default') {
      return data.get(`${host}|${profile}`) ?? null;
    },
    async set(host, credential, profile = 'default') {
      writes.push({ profile, credential });
      data.set(`${host}|${profile}`, credential);
    },
    async delete(host, profile = 'default') {
      data.delete(`${host}|${profile}`);
    },
    async list() {
      return [];
    },
  };
  return store;
}

function intentOf(argv: string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return parsed;
}

/** The handlers receive args with the route path already stripped, as `run.ts` dispatches them. */
function routed(argv: string[], pathLength: number) {
  const parsed = intentOf(argv);
  return { ...parsed, args: parsed.args.slice(pathLength) };
}

function deps(overrides: Partial<AgentCommandDeps> = {}): AgentCommandDeps {
  return {
    discoverTokenEndpoint: async () => ({ tokenEndpoint: TOKEN_ENDPOINT }),
    exchange: vi.fn(async () => tokens('exchanged')),
    solvePow: vi.fn(() => '7'),
    mintKey: vi.fn(async () => ({ id: 'key_1', token: 'mcp_agentkey' })),
    fetchProfile: vi.fn(async () => ({ id: 'agent_1', name: 'Claude', accountType: 'agent' as const, agent: { ownerUserId: null, claimedAt: null, source: 'claude-code' } })),
    pollClaim: vi.fn(async (): Promise<AgentClaimPollResult> => ({ kind: 'authorization_pending' })),
    readSecret: vi.fn(async () => SECRET),
    waitMs: vi.fn(async () => {}),
    now: () => 1_000,
    createIsInterrupted: () => () => false,
    ...overrides,
  };
}

const AGENT_CREDENTIAL: AgentHostCredential = {
  kind: 'agent',
  agentId: 'agent_1',
  secret: SECRET,
  refreshToken: 'ps_rt_stored',
  clientId: 'pagespace-agent',
  claimToken: 'ps_claim_1',
  contentKeyName: 'agent',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const HUMAN_LOGIN: OAuthHostCredential = { kind: 'oauth', refreshToken: 'ps_rt_human', clientId: 'pagespace-cli', scopes: ['manage_keys'], createdAt: '2026-01-01T00:00:00.000Z' };

describe('pagespace signup', () => {
  it('without --agent points people at the browser and agents at --agent, touching nothing', async () => {
    const stderr = createRecordingSink();
    const challenge = vi.fn();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ agent: { challenge } }) });

    const code = await createSignupHandler(deps())(ctx, routed(['signup'], 1));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('pagespace signup --agent');
    expect(challenge).not.toHaveBeenCalled();
  });

  it('runs challenge → proof-of-work → register → exchange → key, storing the secret before anything can fail', async () => {
    const store = profileStore();
    const activeKeyStore = createFakeActiveKeyStore();
    const stdout = createRecordingSink();
    const signup = vi.fn(async (_input: Record<string, unknown>) => IDENTITY);
    const d = deps();
    const ctx = createFakeContext({
      stdout,
      credentialStore: store,
      activeKeyStore,
      sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup } }),
    });

    const code = await createSignupHandler(d)(ctx, routed(['signup', '--agent', '--name', 'Claude', '--source=claude-code'], 1));

    expect(code).toBe(EXIT_SUCCESS);
    expect(d.solvePow).toHaveBeenCalledWith('ps_pow_c1', 4);
    expect(signup).toHaveBeenCalledWith({
      type: 'anonymous',
      name: 'Claude',
      source: 'claude-code',
      tos_accepted: true,
      pow: { challenge: 'ps_pow_c1', nonce: '7' },
    });
    // The very first write is the secret, with no refresh token yet.
    expect(store.writes[0]).toMatchObject({ profile: 'default', credential: { kind: 'agent', secret: SECRET, refreshToken: null, claimToken: 'ps_claim_1' } });
    expect(d.exchange).toHaveBeenCalledWith(TOKEN_ENDPOINT, SECRET, 'pagespace-agent');
    expect(d.mintKey).toHaveBeenCalledWith({ host: HOST, accessToken: 'ps_at_exchanged', name: 'pagespace-cli (agent)' });

    expect(store.read('agent')).toMatchObject({ kind: 'static', token: 'mcp_agentkey' });
    expect(store.read('default')).toMatchObject({ kind: 'agent', agentId: 'agent_1', secret: SECRET, refreshToken: 'ps_rt_exchanged', contentKeyName: 'agent' });
    expect(activeKeyStore.entries.get(HOST)).toBe('agent');

    const output = stdout.lines.join('');
    expect(output).toContain('agent_1');
    expect(output).toContain('pagespace agent claim');
    expect(output).toContain('pagespace mcp');
    expect(output).toContain(PAGESPACE_TERMS_URL);
    expect(output).not.toContain(SECRET);
  });

  it('defaults the source to the CLI and omits the name when none is given', async () => {
    const signup = vi.fn(async (_input: Record<string, unknown>) => IDENTITY);
    const ctx = createFakeContext({ credentialStore: profileStore(), sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup } }) });

    await createSignupHandler(deps())(ctx, routed(['signup', '--agent'], 1));

    expect(signup).toHaveBeenCalledWith(expect.objectContaining({ source: DEFAULT_AGENT_SOURCE }));
    expect(signup.mock.calls[0]?.[0]).not.toHaveProperty('name');
  });

  it('prints the secret only with --show-secret', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, credentialStore: profileStore(), sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup: async () => IDENTITY } }) });

    await createSignupHandler(deps())(ctx, routed(['signup', '--agent', '--show-secret'], 1));

    expect(stdout.lines.join('')).toContain(SECRET);
  });

  it('--json is one machine-readable object; the secret appears in it only with --show-secret', async () => {
    for (const showSecret of [false, true]) {
      const stdout = createRecordingSink();
      const ctx = createFakeContext({ stdout, credentialStore: profileStore(), sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup: async () => IDENTITY } }) });

      await createSignupHandler(deps())(ctx, routed(['signup', '--agent', '--json', ...(showSecret ? ['--show-secret'] : [])], 1));

      const parsed = JSON.parse(stdout.lines.join(''));
      expect(parsed).toMatchObject({ agentId: 'agent_1', accountType: 'agent', claimed: false, keyName: 'agent', activeKey: 'agent' });
      expect(parsed.secret).toBe(showSecret ? SECRET : undefined);
    }
  });

  it('re-solves a fresh challenge once when the proof is refused', async () => {
    const challenge = vi.fn(async () => CHALLENGE);
    const signup = vi
      .fn()
      .mockRejectedValueOnce(new PermissionDeniedError('pow_invalid'))
      .mockResolvedValueOnce(IDENTITY);
    const ctx = createFakeContext({ credentialStore: profileStore(), sdk: fakeSdk({ agent: { challenge, signup } }) });

    expect(await createSignupHandler(deps())(ctx, routed(['signup', '--agent'], 1))).toBe(EXIT_SUCCESS);
    expect(challenge).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite a stored login without --yes, before any network call', async () => {
    const challenge = vi.fn();
    const stderr = createRecordingSink();
    const store = profileStore({ default: HUMAN_LOGIN });
    const ctx = createFakeContext({ stderr, credentialStore: store, sdk: fakeSdk({ agent: { challenge } }) });

    expect(await createSignupHandler(deps())(ctx, routed(['signup', '--agent'], 1))).toBe(EXIT_RUNTIME_ERROR);
    expect(challenge).not.toHaveBeenCalled();
    expect(store.read('default')).toEqual(HUMAN_LOGIN);
    expect(stderr.lines.join('')).toContain('--yes');
  });

  it('keeps the account when the first exchange fails: the secret is stored and a later command retries', async () => {
    const store = profileStore();
    const d = deps({
      exchange: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const ctx = createFakeContext({ credentialStore: store, sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup: async () => IDENTITY } }) });

    expect(await createSignupHandler(d)(ctx, routed(['signup', '--agent'], 1))).toBe(EXIT_SUCCESS);
    expect(store.read('default')).toMatchObject({ kind: 'agent', secret: SECRET, refreshToken: null });
    expect(d.mintKey).not.toHaveBeenCalled();
  });

  it('reports a failed key mint without failing the signup, and names the retry', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      credentialStore: profileStore(),
      sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup: async () => IDENTITY } }),
    });
    const d = deps({
      mintKey: vi.fn(async () => {
        throw new Error('key_limit_reached');
      }),
    });

    expect(await createSignupHandler(d)(ctx, routed(['signup', '--agent'], 1))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('pagespace agent create-key');
  });

  it('reports a registration refusal without storing anything', async () => {
    const store = profileStore();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      credentialStore: store,
      sdk: fakeSdk({ agent: { challenge: async () => CHALLENGE, signup: async () => { throw new ValidationError('invalid_request', []); } } }),
    });

    expect(await createSignupHandler(deps())(ctx, routed(['signup', '--agent'], 1))).toBe(EXIT_RUNTIME_ERROR);
    expect(store.writes).toEqual([]);
    expect(stderr.lines.join('')).toContain('invalid_request');
  });

  it('rejects an unknown flag or a positional argument as a usage error', async () => {
    const ctx = createFakeContext({ credentialStore: profileStore() });
    expect(await createSignupHandler(deps())(ctx, routed(['signup', '--agent', '--secret', 'x'], 1))).toBe(EXIT_USAGE_ERROR);
    expect(await createSignupHandler(deps())(ctx, routed(['signup', '--agent', 'Claude'], 1))).toBe(EXIT_USAGE_ERROR);
    expect(await createSignupHandler(deps())(ctx, routed(['signup', '--agent', '--name'], 1))).toBe(EXIT_USAGE_ERROR);
  });
});

describe('pagespace login --agent', () => {
  it('reads the secret through readSecret (stdin or prompt), exchanges it, stores the agent and its key', async () => {
    const store = profileStore();
    const activeKeyStore = createFakeActiveKeyStore();
    const d = deps();
    const ctx = createFakeContext({ credentialStore: store, activeKeyStore, isTTY: false });

    const code = await createAgentLoginHandler(d)(ctx, routed(['login', '--agent'], 1));

    expect(code).toBe(EXIT_SUCCESS);
    expect(d.readSecret).toHaveBeenCalledWith(expect.objectContaining({ isTTY: false }));
    expect(d.exchange).toHaveBeenCalledWith(TOKEN_ENDPOINT, SECRET, 'pagespace-agent');
    expect(store.read('default')).toMatchObject({ kind: 'agent', agentId: 'agent_1', secret: SECRET, refreshToken: 'ps_rt_exchanged', claimToken: null, contentKeyName: 'agent' });
    expect(store.read('agent')).toMatchObject({ kind: 'static', token: 'mcp_agentkey' });
    expect(activeKeyStore.entries.get(HOST)).toBe('agent');
  });

  it('never takes the secret from argv: a positional is a usage error', async () => {
    const d = deps();
    const ctx = createFakeContext({ credentialStore: profileStore() });
    expect(await createAgentLoginHandler(d)(ctx, routed(['login', '--agent', SECRET], 1))).toBe(EXIT_USAGE_ERROR);
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it('refuses an empty or malformed secret before any network call', async () => {
    for (const given of [null, 'ps_rt_notasecret']) {
      const d = deps({ readSecret: vi.fn(async () => given) });
      const stderr = createRecordingSink();
      const ctx = createFakeContext({ stderr, credentialStore: profileStore() });
      expect(await createAgentLoginHandler(d)(ctx, routed(['login', '--agent'], 1))).toBe(EXIT_USAGE_ERROR);
      expect(d.exchange).not.toHaveBeenCalled();
      expect(stderr.lines.join('')).not.toContain('ps_rt_notasecret');
    }
  });

  it('stores nothing when the server refuses the secret', async () => {
    const store = profileStore();
    const stderr = createRecordingSink();
    const d = deps({ exchange: vi.fn(async () => { throw new ValidationError('invalid_grant', []); }) });
    const ctx = createFakeContext({ stderr, credentialStore: store });

    expect(await createAgentLoginHandler(d)(ctx, routed(['login', '--agent'], 1))).toBe(EXIT_RUNTIME_ERROR);
    expect(store.writes).toEqual([]);
    expect(stderr.lines.join('')).toContain('refused that secret');
  });

  it('stores nothing when the secret signs in as something other than an agent', async () => {
    const store = profileStore();
    const d = deps({ fetchProfile: vi.fn(async () => ({ id: 'u1', name: 'Ada', accountType: 'human' as const, agent: null })) });
    const ctx = createFakeContext({ credentialStore: store });

    expect(await createAgentLoginHandler(d)(ctx, routed(['login', '--agent'], 1))).toBe(EXIT_RUNTIME_ERROR);
    expect(store.writes).toEqual([]);
  });

  it('refuses --device alongside --agent', async () => {
    const ctx = createFakeContext({ credentialStore: profileStore() });
    expect(await createAgentLoginHandler(deps())(ctx, routed(['login', '--agent', '--device'], 1))).toBe(EXIT_USAGE_ERROR);
  });
});

describe('pagespace agent claim', () => {
  const STARTED = {
    user_code: 'ABCD-EFGH',
    verification_uri: `${HOST}/claim`,
    verification_uri_complete: `${HOST}/claim?user_code=ABCD-EFGH`,
    expires_in: 900,
    interval: 5,
  };

  it('prints the code and link, polls at the interval (slower after slow_down), and records the claim', async () => {
    const store = profileStore({ default: AGENT_CREDENTIAL });
    const stdout = createRecordingSink();
    const claim = vi.fn(async () => STARTED);
    const results: AgentClaimPollResult[] = [
      { kind: 'authorization_pending' },
      { kind: 'slow_down' },
      { kind: 'claimed', owner: { id: 'user_h', name: 'Ada' }, tokens: tokens('claimed') },
    ];
    const d = deps({ pollClaim: vi.fn(async (): Promise<AgentClaimPollResult> => results.shift() ?? { kind: 'request_failed', message: 'unexpected' }) });
    const ctx = createFakeContext({ stdout, credentialStore: store, sdk: fakeSdk({ agent: { claim } }) });

    const code = await createAgentClaimHandler(d)(ctx, routed(['agent', 'claim'], 2));

    expect(code).toBe(EXIT_SUCCESS);
    expect(claim).toHaveBeenCalledWith({ claim_token: 'ps_claim_1' });
    expect(d.pollClaim).toHaveBeenCalledWith({ tokenEndpoint: TOKEN_ENDPOINT, claimToken: 'ps_claim_1', clientId: 'pagespace-agent' });
    expect(vi.mocked(d.waitMs).mock.calls.map(([ms]) => ms)).toEqual([5_000, 5_000, 10_000]);
    const output = stdout.lines.join('');
    expect(output).toContain('ABCD-EFGH');
    expect(output).toContain(STARTED.verification_uri_complete);
    expect(output).toContain('Ada');
    expect(store.read('default')).toMatchObject({ kind: 'agent', secret: SECRET, claimToken: null, refreshToken: 'ps_rt_claimed' });
  });

  it('--no-wait prints the link and returns without polling', async () => {
    const d = deps();
    const ctx = createFakeContext({ credentialStore: profileStore({ default: AGENT_CREDENTIAL }), sdk: fakeSdk({ agent: { claim: async () => STARTED } }) });

    expect(await createAgentClaimHandler(d)(ctx, routed(['agent', 'claim', '--no-wait'], 2))).toBe(EXIT_SUCCESS);
    expect(d.pollClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['access_denied', 'declined'],
    ['expired_token', 'expired'],
    ['invalid_grant', 'already redeemed'],
  ] as const)('ends with an error on %s', async (kind, phrase) => {
    const stderr = createRecordingSink();
    const store = profileStore({ default: AGENT_CREDENTIAL });
    const d = deps({ pollClaim: vi.fn(async () => ({ kind }) as AgentClaimPollResult) });
    const ctx = createFakeContext({ stderr, credentialStore: store, sdk: fakeSdk({ agent: { claim: async () => STARTED } }) });

    expect(await createAgentClaimHandler(d)(ctx, routed(['agent', 'claim'], 2))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain(phrase);
    expect(store.read('default')).toEqual(AGENT_CREDENTIAL);
  });

  it('asks for the claim token when this machine has none (an agent that signed in with login --agent)', async () => {
    const claim = vi.fn(async () => STARTED);
    const d = deps({ readSecret: vi.fn(async () => 'ps_claim_piped') });
    const ctx = createFakeContext({ credentialStore: profileStore({ default: { ...AGENT_CREDENTIAL, claimToken: null } }), sdk: fakeSdk({ agent: { claim } }) });

    expect(await createAgentClaimHandler(d)(ctx, routed(['agent', 'claim', '--no-wait'], 2))).toBe(EXIT_SUCCESS);
    expect(claim).toHaveBeenCalledWith({ claim_token: 'ps_claim_piped' });
  });

  it('refuses when no agent account is signed in on this machine', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, credentialStore: profileStore({ default: HUMAN_LOGIN }) });
    expect(await createAgentClaimHandler(deps())(ctx, routed(['agent', 'claim'], 2))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('pagespace signup --agent');
  });

  it('says plainly when the claim token is refused', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      credentialStore: profileStore({ default: AGENT_CREDENTIAL }),
      sdk: fakeSdk({ agent: { claim: async () => { throw new ValidationError('invalid_request', []); } } }),
    });
    expect(await createAgentClaimHandler(deps())(ctx, routed(['agent', 'claim'], 2))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('already be claimed');
  });
});

describe('pagespace agent rotate-secret', () => {
  const ROTATED = { identity_assertion: NEW_SECRET, agent_id: 'agent_1', secret_version: 2, revoked_existing_tokens: false };

  it('stores the new secret, keeping the refresh token, and prints it only with --show-secret', async () => {
    for (const showSecret of [false, true]) {
      const store = profileStore({ default: AGENT_CREDENTIAL });
      const stdout = createRecordingSink();
      const rotateSecret = vi.fn(async () => ROTATED);
      const ctx = createFakeContext({ stdout, credentialStore: store, sdk: fakeSdk({ agent: { rotateSecret } }) });

      const code = await createAgentRotateSecretHandler(deps())(ctx, routed(['agent', 'rotate-secret', ...(showSecret ? ['--show-secret'] : [])], 2));

      expect(code).toBe(EXIT_SUCCESS);
      expect(rotateSecret).toHaveBeenCalledWith({ revokeExistingTokens: false });
      expect(store.read('default')).toMatchObject({ secret: NEW_SECRET, refreshToken: 'ps_rt_stored', contentKeyName: 'agent' });
      expect(stdout.lines.join('').includes(NEW_SECRET)).toBe(showSecret);
    }
  });

  it('--revoke-tokens re-exchanges the new secret and mints a new key (the old ones are dead)', async () => {
    const store = profileStore({ default: AGENT_CREDENTIAL, agent: { kind: 'static', token: 'mcp_old', scopes: [], createdAt: 'x' } });
    const d = deps();
    const ctx = createFakeContext({ credentialStore: store, sdk: fakeSdk({ agent: { rotateSecret: async () => ({ ...ROTATED, revoked_existing_tokens: true }) } }) });

    expect(await createAgentRotateSecretHandler(d)(ctx, routed(['agent', 'rotate-secret', '--revoke-tokens'], 2))).toBe(EXIT_SUCCESS);
    expect(d.exchange).toHaveBeenCalledWith(TOKEN_ENDPOINT, NEW_SECRET, 'pagespace-agent');
    expect(store.read('default')).toMatchObject({ secret: NEW_SECRET, refreshToken: 'ps_rt_exchanged', contentKeyName: 'agent' });
    expect(store.read('agent')).toMatchObject({ token: 'mcp_agentkey' });
  });

  it('changes nothing stored when the rotation is refused', async () => {
    const store = profileStore({ default: AGENT_CREDENTIAL });
    const ctx = createFakeContext({ credentialStore: store, sdk: fakeSdk({ agent: { rotateSecret: async () => { throw new Error('not_found'); } } }) });

    expect(await createAgentRotateSecretHandler(deps())(ctx, routed(['agent', 'rotate-secret'], 2))).toBe(EXIT_RUNTIME_ERROR);
    expect(store.read('default')).toEqual(AGENT_CREDENTIAL);
  });
});

describe('pagespace agent create-key', () => {
  it('mints through ctx.sdk (the stored agent credential) and activates the key', async () => {
    const store = profileStore({ default: { ...AGENT_CREDENTIAL, contentKeyName: null } });
    const activeKeyStore = createFakeActiveKeyStore();
    const invoke = vi.fn(async () => ({ id: 'key_2', name: 'pagespace-cli (agent)', token: 'mcp_second' }));
    const ctx = createFakeContext({ credentialStore: store, activeKeyStore, sdk: fakeSdk({ invoke }) });

    expect(await createAgentCreateKeyHandler(deps())(ctx, routed(['agent', 'create-key'], 2))).toBe(EXIT_SUCCESS);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/auth/mcp-tokens', method: 'POST' }), { name: 'pagespace-cli (agent)' });
    expect(store.read('agent')).toMatchObject({ kind: 'static', token: 'mcp_second' });
    expect(store.read('default')).toMatchObject({ contentKeyName: 'agent' });
    expect(activeKeyStore.entries.get(HOST)).toBe('agent');
  });
});

describe('pagespace whoami — an agent account', () => {
  function whoamiDeps(store: CredentialStore, ownerUserId: string | null) {
    return {
      createCredentialStore: () => store,
      discoverMetadata: async () => ({ authorizationEndpoint: `${HOST}/api/oauth/authorize`, tokenEndpoint: TOKEN_ENDPOINT }),
      createRefreshAccessToken: () => async () => tokens('refreshed'),
      confirmIdentity: async () => {
        throw new Error('an mcp_ key has no /me');
      },
      probeDriveCount: async () => 1,
      now: () => 0,
      exchangeAgentAssertion: async () => tokens('exchanged'),
      fetchAccountProfile: async () => ({ id: 'agent_1', name: 'Claude', accountType: 'agent' as const, agent: { ownerUserId, claimedAt: ownerUserId ? '2026-11-01T00:00:00.000Z' : null, source: 'claude-code' } }),
    };
  }

  it('after signup (active key = the agent key) shows the account type and Unclaimed, and keeps the secret', async () => {
    const store = profileStore({ default: AGENT_CREDENTIAL, agent: { kind: 'static', token: 'mcp_agentkey', scopes: ['all_drives'], createdAt: 'x' } });
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, activeKeyStore: createFakeActiveKeyStore({ [HOST]: 'agent' }) });

    expect(await createWhoamiHandler(whoamiDeps(store, null))(ctx, intentOf(['whoami']))).toBe(EXIT_SUCCESS);

    const output = stdout.lines.join('');
    expect(output).toContain('Account: AI agent');
    expect(output).toContain('agent_1');
    expect(output).toContain('Unclaimed');
    expect(output).toContain('Drives: 1 accessible');
    expect(store.read('default')).toMatchObject({ kind: 'agent', secret: SECRET, refreshToken: 'ps_rt_refreshed' });
  });

  it('names the owner of a claimed agent, and --json carries accountType and claimed', async () => {
    const store = profileStore({ default: AGENT_CREDENTIAL });
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });

    expect(await createWhoamiHandler(whoamiDeps(store, 'user_h'))(ctx, intentOf(['whoami', '--json']))).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed.accountType).toBe('agent');
    expect(parsed.agent).toMatchObject({ id: 'agent_1', ownerUserId: 'user_h', claimed: true });
  });
});

describe('pagespace logout — an agent account', () => {
  it('keeps the agent secret unless --yes, because without it the agent can never sign in again', async () => {
    const store = profileStore({ default: AGENT_CREDENTIAL });
    const revokeToken = vi.fn(async () => ({ outcome: 'revoked' as const }));
    const stderr = createRecordingSink();
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    expect(await handler(createFakeContext({ stderr }), intentOf(['logout']))).toBe(EXIT_RUNTIME_ERROR);
    expect(store.read('default')).toEqual(AGENT_CREDENTIAL);
    expect(revokeToken).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toContain('--yes');

    expect(await handler(createFakeContext(), intentOf(['logout', '--yes']))).toBe(EXIT_SUCCESS);
    expect(revokeToken).toHaveBeenCalledWith({ host: HOST, refreshToken: 'ps_rt_stored', clientId: 'pagespace-agent' });
    expect(store.read('default')).toBeUndefined();
  });
});

describe('pagespace mcp — an agent machine', () => {
  it("starts with no credential named when the resolved credential is the agent's own key", async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handler = createMcpHandler({ createTransport: () => serverTransport });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const ctx = createFakeContext({ agentOwnKey: true, credentialKind: 'key' });

    const [code] = await Promise.all([handler(ctx, intentOf(['mcp'])), client.connect(clientTransport)]);

    expect(code).toBe(EXIT_SUCCESS);
  });

  it('still refuses with no credential named on any other machine', async () => {
    const stderr = createRecordingSink();
    const handler = createMcpHandler({ createTransport: () => { throw new Error('must not start'); } });

    expect(await handler(createFakeContext({ stderr }), intentOf(['mcp']))).toBe(EXIT_RUNTIME_ERROR);
  });
});

describe('pagespace --help', () => {
  it('opens by telling an AI agent it can create its own account', async () => {
    const stdout = createRecordingSink();
    await helpHandler(createFakeContext({ stdout }), intentOf(['help']));

    const output = stdout.lines.join('');
    expect(output.indexOf('pagespace signup --agent')).toBeGreaterThan(-1);
    expect(output.indexOf('pagespace signup --agent')).toBeLessThan(output.indexOf('Auth:'));
    expect(output).toContain('agent claim');
  });
});
