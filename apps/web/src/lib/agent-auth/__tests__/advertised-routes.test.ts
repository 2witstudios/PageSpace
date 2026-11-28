// @vitest-environment node
/**
 * Everything the agent door ADVERTISES must exist (Agent Signup Phase 4).
 *
 * The 2026-09-22 independent review found `/auth.md` and the RFC 8414
 * `agent_auth` block advertising a claim endpoint, a claim grant and a human
 * `/claim` page that all 404'd — an agent following the documented funding
 * path could not be funded. This test reads the two documents themselves and
 * requires:
 *   - every URL either document names (under the issuer) to resolve to a
 *     MOUNTED route — `route.ts` for an API path, `page.tsx` otherwise, through
 *     the well-known rewrite list for the dot/`.md` paths, with `[param]`
 *     directories matching a path segment;
 *   - every grant type the metadata advertises to be dispatched by the token
 *     endpoint (anything but `unsupported_grant_type`).
 * A new URL or grant added to either document without its route fails here.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/repositories/oauth-repository', () => ({
  ensureOAuthClientRow: vi.fn().mockResolvedValue('client-db'),
  exchangeAuthorizationCode: vi.fn(),
  refreshTokenGrant: vi.fn(),
  pollDeviceToken: vi.fn(),
  exchangeAgentAssertion: vi.fn(),
  findRefreshTokenFamilyId: vi.fn(),
}));
vi.mock('@/lib/repositories/agent-claim-repository', () => ({ pollAgentClaim: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/onboarding/home-drive', () => ({ provisionHomeDriveIfNeeded: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(), logTokenActivity: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: () => '203.0.113.1' }));
vi.mock('@/lib/agent-auth/door', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth/door')>()),
  isAgentDoorOpen: () => true,
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: {},
}));

import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';
import { WELL_KNOWN_REWRITES } from '@/lib/well-known/rewrites';
import { buildAuthMd } from '../auth-md';
import { POST as tokenPOST } from '@/app/api/oauth/token/route';

const ISSUER = 'https://pagespace.test';
const APP_DIR = join(__dirname, '..', '..', '..', 'app');

/** Next.js route groups `(name)` add no URL segment; walk through them. */
function childDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

/** Directories under `dir` that serve `segment`: an exact name, a `[param]`, or one reached through a `(group)`. */
function matchSegment(dir: string, segment: string): string[] {
  const out: string[] = [];
  for (const name of childDirs(dir)) {
    const full = join(dir, name);
    if (name === segment || (name.startsWith('[') && !name.startsWith('[...') && name.endsWith(']'))) out.push(full);
    else if (name.startsWith('(') && name.endsWith(')')) out.push(...matchSegment(full, segment));
  }
  return out;
}

/** The mounted file that serves `pathname`, or null. */
function mountedFile(pathname: string): string | null {
  const rewrite = WELL_KNOWN_REWRITES.find((r) => r.source === pathname);
  const path = rewrite ? rewrite.destination : pathname;
  const file = path.startsWith('/api/') ? 'route.ts' : 'page.tsx';
  let dirs = [APP_DIR];
  for (const segment of path.split('/').filter(Boolean)) {
    dirs = dirs.flatMap((dir) => matchSegment(dir, segment));
  }
  for (const dir of dirs) {
    if (existsSync(join(dir, file))) return join(dir, file);
    if (file === 'page.tsx' && existsSync(join(dir, 'page.ts'))) return join(dir, 'page.ts');
  }
  return null;
}

const metadata = buildServerMetadata({ issuer: ISSUER });
const authMd = buildAuthMd({ issuer: ISSUER });

function urlsInMetadata(): string[] {
  const top = [metadata.authorization_endpoint, metadata.token_endpoint, metadata.device_authorization_endpoint, metadata.revocation_endpoint];
  const agent = Object.values(metadata.agent_auth).filter((v): v is string => typeof v === 'string' && v.startsWith(`${ISSUER}/`));
  return [`${ISSUER}/.well-known/oauth-authorization-server`, ...top, ...agent];
}

function urlsInAuthMd(): string[] {
  const escaped = ISSUER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...authMd.matchAll(new RegExp(`${escaped}/[^\\s\`"')|<>]*`, 'g'))].map((m) => m[0]);
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

describe('every URL the agent door advertises resolves to a mounted route', () => {
  const advertised = [...new Set([...urlsInMetadata(), ...urlsInAuthMd()].map(pathOf))].sort();

  it('finds the URLs it is meant to check (the claim path among them)', () => {
    expect(advertised).toEqual(expect.arrayContaining(['/api/agent/claim', '/claim', '/auth.md', '/api/oauth/token', '/api/agent/identity', '/api/agent/challenge']));
  });

  it.each(advertised)('%s is mounted', (pathname) => {
    expect(mountedFile(pathname), `${pathname} is advertised but no route.ts/page.tsx serves it`).not.toBeNull();
  });

  it('the key-revoke path /auth.md names (DELETE /api/auth/mcp-tokens/<id>) is mounted', () => {
    expect(authMd).toContain('DELETE /api/auth/mcp-tokens/<id>');
    expect(mountedFile('/api/auth/mcp-tokens/some-key-id')).not.toBeNull();
  });

  it('the resolver itself fails closed on a path nothing serves', () => {
    expect(mountedFile('/api/agent/does-not-exist')).toBeNull();
    expect(mountedFile('/definitely-not-a-page')).toBeNull();
  });
});

describe('every grant type the metadata advertises is spoken by the token endpoint', () => {
  const grants = [...new Set([...metadata.grant_types_supported, metadata.agent_auth.assertion_grant_type, metadata.agent_auth.claim_grant_type])];

  it.each(grants)('%s is dispatched (never unsupported_grant_type)', async (grantType) => {
    const res = await tokenPOST(new Request(`${ISSUER}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: grantType }).toString(),
    }) as never);
    const body = await res.json() as { error?: string };
    expect(body.error).not.toBe('unsupported_grant_type');
  });

  it('control: an unknown grant IS unsupported', async () => {
    const res = await tokenPOST(new Request(`${ISSUER}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:example:nope' }).toString(),
    }) as never);
    expect(await res.json()).toEqual({ error: 'unsupported_grant_type' });
  });
});
