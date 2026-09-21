/**
 * GET /api/well-known/auth-md — destination of the `/auth.md` rewrite (Agent
 * Signup Phase 2 leaf 5; ADR 0007 Decision 12, threat model T14).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAuthMd } from '@/lib/agent-auth/auth-md';

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/well-known/auth-md (destination of the /auth.md rewrite)', () => {
  beforeEach(() => {
    process.env.WEB_APP_URL = 'https://pagespace.ai';
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.AGENT_SIGNUP_ENABLED;
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('given an open door, should serve buildAuthMd for the configured issuer as text/markdown', async () => {
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe(buildAuthMd({ issuer: 'https://pagespace.ai' }));
  });

  it('should be publicly cacheable for five minutes (public recipe, no secrets)', async () => {
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('should take no request input, so a Host header can never reach the document (T14)', async () => {
    const { GET } = await import('../route');
    expect(GET.length).toBe(0);
    expect(await (await GET()).text()).toContain('https://pagespace.ai/api/agent/identity');
  });

  it('given an onprem deployment without the opt-in, should answer 404 (the door does not exist)', async () => {
    process.env.DEPLOYMENT_MODE = 'onprem';
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('/api/agent/identity');
  });

  it('given an onprem deployment with AGENT_SIGNUP_ENABLED=true, should serve the recipe', async () => {
    process.env.DEPLOYMENT_MODE = 'onprem';
    process.env.AGENT_SIGNUP_ENABLED = 'true';
    const { GET } = await import('../route');
    expect((await GET()).status).toBe(200);
  });
});
