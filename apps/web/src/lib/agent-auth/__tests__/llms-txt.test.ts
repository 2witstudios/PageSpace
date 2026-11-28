/**
 * `/llms.txt` — the discovery document an AI agent finds first (llmstxt.org).
 * It must tell an agent, in plain words, that it may create a PageSpace
 * account of its own and where the recipe is — and only when that door is
 * actually open on this deployment.
 */
import { describe, it, expect } from 'vitest';
import { buildLlmsTxt } from '../llms-txt';
import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

const issuer = 'https://pagespace.ai';

describe('buildLlmsTxt', () => {
  it('should follow the llms.txt shape: an H1 title, then a blockquote summary', () => {
    const lines = buildLlmsTxt({ issuer, agentSignupOpen: true }).split('\n');
    expect(lines[0]).toBe('# PageSpace');
    expect(lines.find((l) => l.startsWith('> '))).toBeDefined();
  });

  it('given an open agent door, should say an agent can create its own account and link the recipe and metadata', () => {
    const doc = buildLlmsTxt({ issuer, agentSignupOpen: true });
    expect(doc).toMatch(/create (a|your own) PageSpace account/i);
    expect(doc).toMatch(/no email/i);
    expect(doc).toContain(`${issuer}/auth.md`);
    expect(doc).toContain(`${issuer}/.well-known/oauth-authorization-server`);
    expect(doc).toContain(buildServerMetadata({ issuer }).agent_auth.skill);
  });

  it('given an open agent door, should name the CLI one-liner and the browser door', () => {
    const doc = buildLlmsTxt({ issuer, agentSignupOpen: true });
    expect(doc).toContain('pagespace signup --agent');
    expect(doc).toContain(`${issuer}/auth/agent`);
  });

  it('given a closed agent door, should not advertise agent signup at all', () => {
    const doc = buildLlmsTxt({ issuer, agentSignupOpen: false });
    expect(doc).not.toContain('/auth.md');
    expect(doc).not.toContain('signup --agent');
    expect(doc).not.toContain('/auth/agent');
  });

  it('should build every URL from the issuer, tolerating a trailing slash', () => {
    const doc = buildLlmsTxt({ issuer: `${issuer}/`, agentSignupOpen: true });
    expect(doc).not.toContain('pagespace.ai//');
    const urls = doc.match(/https?:\/\/[^\s)>\]`]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(issuer)).toBe(true);
  });
});
