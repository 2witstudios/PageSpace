/**
 * ADR 0008 Decision 12 — `/auth.md` is pure markdown built from the issuer,
 * and it is pinned to the RFC 8414 metadata by iterating over the metadata
 * object itself: a new agent_auth endpoint that is not documented here fails
 * this test, so the two documents cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';
import { buildAuthMd, AUTH_MD_SECTIONS } from '../auth-md';

const ISSUER = 'https://pagespace.ai';

describe('buildAuthMd', () => {
  const md = buildAuthMd({ issuer: ISSUER });
  const metadata = buildServerMetadata({ issuer: ISSUER });

  it('contains every URL in agent_auth, discovered by iterating the metadata (drift guard)', () => {
    const urls = Object.values(metadata.agent_auth).filter(
      (v): v is string => typeof v === 'string' && v.startsWith(`${ISSUER}/`),
    );
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) {
      expect(md).toContain(url);
    }
  });

  it('gives every POST in the recipe a Content-Type, so a request built from it literally is accepted', () => {
    const blocks = md.split('```').filter((_, i) => i % 2 === 1).filter((block) => block.trimStart().startsWith('POST '));
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const block of blocks) {
      expect(block).toMatch(/\nContent-Type: (application\/json|application\/x-www-form-urlencoded)\n/);
    }
  });

  it('names the key-mint endpoint a headless agent uses with its own access token (ADR 0008 D6, assertion 25)', () => {
    expect(md).toContain(`POST ${ISSUER}/api/auth/mcp-tokens\nAuthorization: Bearer <access_token>`);
  });

  it('contains the token and revocation endpoints and the metadata URL itself', () => {
    expect(md).toContain(metadata.token_endpoint);
    expect(md).toContain(metadata.revocation_endpoint);
    expect(md).toContain(`${ISSUER}/.well-known/oauth-authorization-server`);
  });

  it('names both grant URNs and the client id exactly as the token endpoint expects them', () => {
    expect(md).toContain(metadata.agent_auth.assertion_grant_type);
    expect(md).toContain(metadata.agent_auth.claim_grant_type);
    expect(md).toContain('client_id=pagespace-agent');
  });

  it('has the eight sections in order: Discover → Prove work → Register → Exchange → Use → Fund → Rotate/Revoke → Limits', () => {
    expect(AUTH_MD_SECTIONS).toEqual([
      'Discover',
      'Prove work',
      'Register',
      'Exchange',
      'Use',
      'Fund',
      'Rotate / Revoke',
      'Limits',
    ]);
    let cursor = -1;
    for (const section of AUTH_MD_SECTIONS) {
      const idx = md.indexOf(`## ${section}`);
      expect(idx, `section "${section}" missing`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('derives every URL from the issuer — a self-hosted origin appears verbatim and pagespace.ai does not', () => {
    const onprem = buildAuthMd({ issuer: 'http://onprem.internal:3000/' });
    expect(onprem).toContain('http://onprem.internal:3000/api/agent/identity');
    expect(onprem).not.toContain('pagespace.ai');
  });

  it('tells the agent the PoW input shape and hash exactly (challenge:nonce, SHA3-256, leading zero bits)', () => {
    expect(md).toContain('SHA3-256');
    expect(md).toContain('`<challenge>:<nonce>`');
    expect(md).toContain('leading zero bits');
  });

  it('states there are no free AI credits and that a human claim is the funding path (US4)', () => {
    expect(md).toContain('requires_funding');
    expect(md).toContain('no free AI credits');
  });

  it('warns that the secret is shown once and is the identity_assertion', () => {
    expect(md).toContain('identity_assertion');
    expect(md).toContain('shown once');
  });

  it('names the browser door for agents that drive a browser: sign up and sign in at /auth/agent', () => {
    expect(md).toContain(`${ISSUER}/auth/agent?mode=signup`);
    expect(md).toContain(`${ISSUER}/auth/agent?mode=signin`);
  });

  it('names the CLI path, installed and without installing', () => {
    expect(md).toContain('npm i -g @pagespace/cli && pagespace signup --agent');
    expect(md).toContain('npx -y -p @pagespace/cli pagespace signup --agent');
  });

  it('given a self-hosted issuer, points the CLI at that deployment rather than the CLI default host', () => {
    const selfHosted = buildAuthMd({ issuer: 'http://onprem.internal:3000/' });
    expect(selfHosted).toContain('pagespace signup --agent --host=http://onprem.internal:3000');
  });

  it('documents the rotate response exactly as the rotate route returns it', () => {
    const rotate = md.slice(md.indexOf(`## ${AUTH_MD_SECTIONS[6]}`));
    expect(rotate).toContain('→ { "identity_assertion": "ps_agent_…", "agent_id": "…", "secret_version": 2, "revoked_existing_tokens": false }');
  });

  it('documents the claim grant success body exactly as the token endpoint returns it', () => {
    expect(md).toContain('{ "claimed": true, "owner": { "id": "…", "name": "…" }, "access_token": "ps_at_…", "token_type": "Bearer", "expires_in": 900, "refresh_token": "ps_rt_…", "scope": "account offline_access" }');
  });

  it('tells a late poller what an expired claim answers, and when it stops answering that', () => {
    expect(md).toContain('`expired_token` (the claim lived 15 minutes; start a new one with the same `claim_token`)');
    expect(md).toContain('a claim that expired more than a day ago');
  });

  it('is pure: identical input, identical output, and no markup outside markdown', () => {
    expect(buildAuthMd({ issuer: ISSUER })).toBe(md);
    expect(md.startsWith('# ')).toBe(true);
    expect(md).not.toContain('<script');
  });
});
