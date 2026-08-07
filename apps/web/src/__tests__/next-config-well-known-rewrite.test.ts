import { describe, it, expect } from 'vitest';

describe('next.config rewrites — RFC 8414 discovery URL', () => {
  it('rewrites /.well-known/oauth-authorization-server via beforeFiles (afterFiles never fires — the namespace is prerendered as 404)', async () => {
    const { nextConfig } = await import('../../next.config');

    const rewrites = await nextConfig.rewrites?.();

    // MUST be a beforeFiles rewrite. Because public/.well-known/ exists, Next
    // treats /.well-known/* as a static namespace and prerenders a 404 for it;
    // an afterFiles rewrite runs after that filesystem check and never fires
    // (observed in prod: /.well-known/... returned a cached 404). beforeFiles
    // runs before the filesystem/prerender lookup, so the rewrite wins.
    const beforeFiles = Array.isArray(rewrites) ? [] : (rewrites?.beforeFiles ?? []);
    expect(beforeFiles).toContainEqual({
      source: '/.well-known/oauth-authorization-server',
      destination: '/api/well-known/oauth-authorization-server',
    });
  });
});

describe('next.config rewrites — agent-sessions → agent-workspaces compat alias', () => {
  it('aliases the pre-rename API paths via afterFiles, so a stale browser bundle keeps working through the deploy', async () => {
    const { nextConfig } = await import('../../next.config');

    const rewrites = await nextConfig.rewrites?.();
    const afterFiles = Array.isArray(rewrites) ? [] : (rewrites?.afterFiles ?? []);

    // afterFiles, NOT beforeFiles: the real /api/agent-workspaces/** handlers
    // must win on their own paths, and this only catches requests that would
    // otherwise 404.
    expect(afterFiles).toContainEqual({
      source: '/api/agent-sessions',
      destination: '/api/agent-workspaces',
    });
    expect(afterFiles).toContainEqual({
      source: '/api/agent-sessions/:path*',
      destination: '/api/agent-workspaces/:path*',
    });
  });
});
