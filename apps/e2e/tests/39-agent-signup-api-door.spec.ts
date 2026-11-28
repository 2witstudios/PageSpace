import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { solvePowFromRecipe } from '../fixtures/agent-signup.fixture';

/**
 * Agent Signup, the API door, against the running app (ADR 0008; epic stories US1, US4, US8).
 *
 * The Phase 5 master-PR rule: nothing `/auth.md` or the RFC 8414 metadata advertises may be
 * missing on a running app — "verified by fetching each advertised URL, not by reading the
 * source". So this spec reads the three discovery documents the way an agent would, collects
 * every same-origin URL they name, and requires each one to be exercised below with the method
 * and credential the recipe gives it, answering something other than 404 or a 5xx. A URL added
 * to a document without a probe here fails the coverage assertion, so the list cannot rot.
 *
 * Along the way it walks the recipe end to end as a headless agent — challenge, proof of work,
 * register, exchange, `/api/auth/me`, mint and revoke a key, start a claim, poll it, rotate,
 * revoke — and holds each response to the shape `/auth.md` documents.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(180_000);

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

interface AgentAuthBlock {
  skill: string;
  identity_endpoint: string;
  claim_endpoint: string;
  challenge_endpoint: string;
  identity_types_supported: string[];
  assertion_grant_type: string;
  claim_grant_type: string;
}

interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
  grant_types_supported: string[];
  agent_auth: AgentAuthBlock;
}

/** Every absolute URL on `origin` a document names, with its query string. */
function urlsOn(origin: string, text: string): string[] {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`${escaped}/[^\\s\`"')|<>\\]]*`, 'g'))].map((m) => m[0].replace(/[.,:;]+$/, ''));
}

/** A path with its query, relative to the origin: the key every probe below is recorded under. */
function pathKey(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

/** The answers that mean "not mounted" or "broken": anything else proves the route is live. */
function expectLive(res: APIResponse, what: string): void {
  expect(res.status(), `${what} answered ${res.status()}`).not.toBe(404);
  expect(res.status(), `${what} answered ${res.status()}`).toBeLessThan(500);
}

async function exchange(request: APIRequestContext, tokenEndpoint: string, grantType: string, secret: string) {
  return request.post(tokenEndpoint, {
    headers: FORM,
    data: new URLSearchParams({ grant_type: grantType, assertion: secret, client_id: 'pagespace-agent' }).toString(),
  });
}

test.describe('agent signup: the API door on a running app', () => {
  test('every URL /auth.md, /llms.txt and the server metadata advertise answers, and the recipe works as written', async ({
    request,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    /** pathKey → the HTTP status the probe for it got. */
    const probed = new Map<string, number>();
    const record = (url: string, res: APIResponse, what: string) => {
      expectLive(res, what);
      probed.set(pathKey(url), res.status());
    };

    // ── Discover ──────────────────────────────────────────────────────────────────────────
    const metadataUrl = `${origin}/.well-known/oauth-authorization-server`;
    const metadataRes = await request.get(metadataUrl);
    expect(metadataRes.status()).toBe(200);
    record(metadataUrl, metadataRes, 'server metadata');
    const metadata = (await metadataRes.json()) as ServerMetadata;
    const agent = metadata.agent_auth;
    expect(agent, 'the RFC 8414 document carries agent_auth').toBeDefined();
    expect(metadata.issuer).toBe(origin);
    expect(agent.identity_types_supported).toContain('anonymous');
    expect(metadata.grant_types_supported).toEqual(expect.arrayContaining([agent.assertion_grant_type, agent.claim_grant_type]));

    const authMdRes = await request.get(agent.skill);
    expect(authMdRes.status()).toBe(200);
    expect(authMdRes.headers()['content-type']).toContain('text/markdown');
    record(agent.skill, authMdRes, '/auth.md');
    const authMd = await authMdRes.text();
    expect(authMd.startsWith('# ')).toBe(true);

    const llmsUrl = `${origin}/llms.txt`;
    const llmsRes = await request.get(llmsUrl);
    expect(llmsRes.status()).toBe(200);
    record(llmsUrl, llmsRes, '/llms.txt');
    const llms = await llmsRes.text();
    expect(llms).toContain(agent.skill);

    // The documents' own links, plus every URL-valued field of the metadata.
    const metadataUrls = [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.device_authorization_endpoint,
      metadata.revocation_endpoint,
      ...Object.values(agent).filter((v): v is string => typeof v === 'string' && v.startsWith(`${origin}/`)),
    ];
    const advertised = [...new Set([...metadataUrls, ...urlsOn(origin, authMd), ...urlsOn(origin, llms)].map(pathKey))].sort();
    expect(advertised).toEqual(expect.arrayContaining(['/api/agent/claim', '/claim', '/auth.md', '/api/oauth/token']));

    // ── Prove work ────────────────────────────────────────────────────────────────────────
    const challengeRes = await request.get(agent.challenge_endpoint);
    expect(challengeRes.status()).toBe(200);
    record(agent.challenge_endpoint, challengeRes, 'challenge endpoint');
    const challenge = (await challengeRes.json()) as { challenge: string; difficulty_bits: number; expires_in: number; algorithm: string; input: string };
    expect(challenge.algorithm).toBe('sha3-256');
    expect(challenge.expires_in).toBe(300);
    expect(challenge.input).toBe(`${challenge.challenge}:<nonce>`);
    const nonce = solvePowFromRecipe(challenge.challenge, challenge.difficulty_bits);

    // ── Register ──────────────────────────────────────────────────────────────────────────
    const identityRes = await request.post(agent.identity_endpoint, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({
        type: 'anonymous',
        name: `E2E API agent ${Date.now()}`,
        source: 'playwright-e2e',
        tos_accepted: true,
        pow: { challenge: challenge.challenge, nonce },
      }),
    });
    expect(identityRes.status(), await identityRes.text()).toBe(200);
    record(agent.identity_endpoint, identityRes, 'identity endpoint');
    const identity = (await identityRes.json()) as Record<string, string>;
    expect(Object.keys(identity).sort()).toEqual(
      ['identity_assertion', 'agent_id', 'claim_token', 'account_type', 'token_endpoint', 'grant_type', 'client_id', 'claim_endpoint'].sort(),
    );
    expect(identity.identity_assertion).toMatch(/^ps_agent_/);
    expect(identity.account_type).toBe('agent');
    expect(identity.token_endpoint).toBe(metadata.token_endpoint);
    expect(identity.grant_type).toBe(agent.assertion_grant_type);
    expect(identity.client_id).toBe('pagespace-agent');
    expect(identity.claim_endpoint).toBe(agent.claim_endpoint);

    // ── Exchange ──────────────────────────────────────────────────────────────────────────
    const tokenRes = await exchange(request, metadata.token_endpoint, agent.assertion_grant_type, identity.identity_assertion);
    expect(tokenRes.status(), await tokenRes.text()).toBe(200);
    record(metadata.token_endpoint, tokenRes, 'token endpoint (jwt-bearer)');
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
    expect(tokens.access_token).toMatch(/^ps_at_/);
    expect(tokens.refresh_token).toMatch(/^ps_rt_/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope.split(' ').sort()).toEqual(['account', 'offline_access']);
    const bearer = { authorization: `Bearer ${tokens.access_token}` };

    // ── Use ───────────────────────────────────────────────────────────────────────────────
    const meUrl = `${origin}/api/auth/me`;
    const meRes = await request.get(meUrl, { headers: bearer });
    expect(meRes.status()).toBe(200);
    record(meUrl, meRes, '/api/auth/me');
    expect(((await meRes.json()) as { accountType: string }).accountType).toBe('agent');

    const keysUrl = `${origin}/api/auth/mcp-tokens`;
    const keyRes = await request.post(keysUrl, {
      headers: { ...bearer, 'content-type': 'application/json' },
      data: JSON.stringify({ name: 'e2e agent key' }),
    });
    expect(keyRes.status(), await keyRes.text()).toBe(200);
    record(keysUrl, keyRes, 'key mint');
    const key = (await keyRes.json()) as { id: string; token: string };
    expect(key.token).toMatch(/^mcp_/);
    // The key acts as the agent: it lists the agent's drives and creates a page in its home drive.
    const keyAuth = { authorization: `Bearer ${key.token}` };
    const drivesWithKey = await request.get(`${origin}/api/drives`, { headers: keyAuth });
    expect(drivesWithKey.status()).toBe(200);
    const drives = (await drivesWithKey.json()) as Array<{ id: string; ownerId?: string }>;
    const homeDriveId = drives.find((d) => d.ownerId === identity.agent_id)?.id ?? drives[0]?.id;
    expect(homeDriveId, 'a new agent has a home drive').toBeTruthy();
    const pageRes = await request.post(`${origin}/api/pages`, {
      headers: { ...keyAuth, 'content-type': 'application/json' },
      data: JSON.stringify({ title: 'API agent chat', type: 'AI_CHAT', driveId: homeDriveId }),
    });
    expect(pageRes.status(), await pageRes.text()).toBe(201);
    const chatId = ((await pageRes.json()) as { id: string }).id;

    // An unfunded agent's first AI call: 402 requires_funding with the claim endpoint (US4).
    const aiRes = await request.post(`${origin}/api/ai/chat`, {
      headers: { ...keyAuth, 'content-type': 'application/json', 'X-Browser-Session-Id': 'e2e-agent-api-door' },
      data: JSON.stringify({ chatId, messages: [{ id: 'e2e-api-door', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }),
    });
    expect(aiRes.status(), await aiRes.text()).toBe(402);
    const refusal = (await aiRes.json()) as { error: string; claim_url: string; message: string };
    expect(refusal.error).toBe('requires_funding');
    expect(refusal.claim_url).toBe(agent.claim_endpoint);
    expect(refusal.message).toContain(agent.skill);

    // ...and the agent can revoke the key again, as the Limits section says, with its access token.
    const revokeKey = await request.delete(`${keysUrl}/${key.id}`, { headers: bearer });
    expect(revokeKey.status(), await revokeKey.text()).toBe(200);
    expect([401, 403], 'a revoked key is dead').toContain((await request.get(`${origin}/api/drives`, { headers: keyAuth })).status());

    // ── Fund ──────────────────────────────────────────────────────────────────────────────
    const claimRes = await request.post(agent.claim_endpoint, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ claim_token: identity.claim_token }),
    });
    expect(claimRes.status(), await claimRes.text()).toBe(200);
    record(agent.claim_endpoint, claimRes, 'claim endpoint');
    const claim = (await claimRes.json()) as { user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
    expect(Object.keys(claim).sort()).toEqual(['expires_in', 'interval', 'user_code', 'verification_uri', 'verification_uri_complete']);
    expect(claim.verification_uri).toBe(`${origin}/claim`);
    expect(claim.verification_uri_complete).toBe(`${origin}/claim?user_code=${encodeURIComponent(claim.user_code)}`);
    expect(claim.expires_in).toBe(900);
    expect(claim.interval).toBe(5);

    // The human page the claim hands out: signed out, it sends the person to sign in and back.
    const claimPageRes = await request.get(claim.verification_uri_complete, { maxRedirects: 0 });
    expectLive(claimPageRes, '/claim');
    expect(claimPageRes.headers().location ?? '').toContain('/auth/signin?next=');
    probed.set('/claim', claimPageRes.status());

    // Poll: nobody has approved yet.
    const pollRes = await request.post(metadata.token_endpoint, {
      headers: FORM,
      data: new URLSearchParams({ grant_type: agent.claim_grant_type, claim_token: identity.claim_token, client_id: 'pagespace-agent' }).toString(),
    });
    expect(pollRes.status()).toBe(400);
    expect(((await pollRes.json()) as { error: string }).error).toBe('authorization_pending');

    // ── Rotate / Revoke ───────────────────────────────────────────────────────────────────
    const rotateUrl = `${origin}/api/agent/secret/rotate`;
    const rotateRes = await request.post(rotateUrl, {
      headers: { ...bearer, 'content-type': 'application/json' },
      data: JSON.stringify({ revokeExistingTokens: false }),
    });
    expect(rotateRes.status(), await rotateRes.text()).toBe(200);
    record(rotateUrl, rotateRes, 'secret rotation');
    const rotated = (await rotateRes.json()) as { identity_assertion: string; agent_id: string; secret_version: number; revoked_existing_tokens: boolean };
    expect(Object.keys(rotated).sort()).toEqual(['agent_id', 'identity_assertion', 'revoked_existing_tokens', 'secret_version']);
    expect(rotated.identity_assertion).toMatch(/^ps_agent_/);
    expect(rotated.agent_id).toBe(identity.agent_id);
    expect(rotated.revoked_existing_tokens).toBe(false);
    // The old secret stops working at once; the new one exchanges.
    expect((await exchange(request, metadata.token_endpoint, agent.assertion_grant_type, identity.identity_assertion)).status()).toBe(400);
    expect((await exchange(request, metadata.token_endpoint, agent.assertion_grant_type, rotated.identity_assertion)).status()).toBe(200);

    const revokeRes = await request.post(metadata.revocation_endpoint, {
      headers: FORM,
      data: new URLSearchParams({ token: tokens.access_token, client_id: 'pagespace-agent' }).toString(),
    });
    expect(revokeRes.status()).toBe(200);
    record(metadata.revocation_endpoint, revokeRes, 'revocation endpoint');
    expect([401, 403], 'a revoked access token is dead').toContain((await request.get(meUrl, { headers: bearer })).status());

    // ── The rest of what is advertised: mounted and answering ─────────────────────────────
    // The authorization endpoint without a request: a refusal or a redirect, never a 404.
    const authorizeRes = await request.get(metadata.authorization_endpoint, { maxRedirects: 0 });
    record(metadata.authorization_endpoint, authorizeRes, 'authorization endpoint');
    // The device endpoint with no client: invalid_request, never a 404.
    const deviceRes = await request.post(metadata.device_authorization_endpoint, { headers: FORM, data: '' });
    record(metadata.device_authorization_endpoint, deviceRes, 'device authorization endpoint');
    // Pages a person or a browser agent opens.
    for (const page of advertised.filter((p) => !p.startsWith('/api/') && !probed.has(p))) {
      const res = await request.get(`${origin}${page}`, { maxRedirects: 0 });
      record(`${origin}${page}`, res, page);
    }

    // Coverage: every advertised same-origin URL was fetched above and answered.
    const unprobed = advertised.filter((p) => !probed.has(p));
    expect(unprobed, `advertised but never fetched: ${unprobed.join(', ')}`).toEqual([]);
  });
});
