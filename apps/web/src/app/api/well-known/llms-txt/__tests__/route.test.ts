/**
 * GET /api/well-known/llms-txt — destination of the `/llms.txt` rewrite: the
 * discovery document that tells an AI agent it can create its own account.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildLlmsTxt } from '@/lib/agent-auth/llms-txt';

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/well-known/llms-txt (destination of the /llms.txt rewrite)', () => {
  beforeEach(() => {
    process.env.WEB_APP_URL = 'https://pagespace.ai';
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.AGENT_SIGNUP_ENABLED;
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('given an open door, should serve buildLlmsTxt with the agent section as text/plain', async () => {
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe(buildLlmsTxt({ issuer: 'https://pagespace.ai', agentSignupOpen: true }));
  });

  it('should be publicly cacheable and take no request input (T14)', async () => {
    const { GET } = await import('../route');
    expect(GET.length).toBe(0);
    expect((await GET()).headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('given onprem without the opt-in, should still serve llms.txt but without the agent signup section', async () => {
    process.env.DEPLOYMENT_MODE = 'onprem';
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('/auth.md');
  });
});
