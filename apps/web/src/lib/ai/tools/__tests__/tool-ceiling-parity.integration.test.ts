/**
 * Agent-tool ROLE ceiling parity — mcp_ key ⇄ OAuth drive grant, against a real
 * Postgres (Sign in with PageSpace, Phase 2b; epic yv08hib74nrtmksdzxmf5nkw, US2).
 *
 * The same user OWNS drive X and holds two credentials with the same scope and
 * role in it: a drive-scoped `mcp_` key (`mcp_token_drives` row) and a
 * third-party `ps_at_` access token (`drive:X:<role>`). Each credential is run
 * through the REAL `authenticateRequestWithOptions`, the context is built by
 * the one production helper every tool-executing entry point spreads
 * (`toolCredentialScope`), and REAL tools execute against REAL rows.
 *
 * Because the user owns X, anything the credential's role does not grant can
 * only be refused by the ceiling — the user's own ACL would allow all of it.
 * So every pinned `denied` below is the ceiling at work, and the session row
 * (the owner acting as themself) is the control proving the user could.
 *
 * Stubbed only: realtime broadcasts, the audit sink, rate limiting, and the
 * object-storage effects of page writes. Requires DATABASE_URL → a migrated
 * Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveRoles, mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

vi.mock('@/lib/websocket', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/websocket')>();
  return {
    ...real,
    broadcastPageEvent: vi.fn(async () => undefined),
    broadcastDriveEvent: vi.fn(async () => undefined),
    broadcastTaskEvent: vi.fn(async () => undefined),
    broadcastCalendarEvent: vi.fn(async () => undefined),
    broadcastDriveMemberEvent: vi.fn(async () => undefined),
  };
});
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>();
  const { createHash } = await import('node:crypto');
  return {
    ...real,
    writePageContent: vi.fn(async (content: string, format: string) => {
      const size = Buffer.byteLength(content, 'utf8');
      return { ref: `${format}:${createHash('sha256').update(content).digest('hex')}`, size, compressed: false, storedSize: size, compressionRatio: 1 };
    }),
  };
});
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>();
  const { createId: id } = await import('@paralleldrive/cuid2');
  return {
    ...real,
    createPageVersion: vi.fn(async (input: { content: string }) => {
      const size = Buffer.byteLength(input.content, 'utf8');
      return { id: id(), contentRef: 'parity-snapshot', contentSize: size, compressed: false, storedSize: size, compressionRatio: 1 };
    }),
  };
});

import { authenticateRequestWithOptions, isAuthError, validateOAuthAccessToken } from '@/lib/auth';
import { loadServicePrincipal } from '@/lib/auth';
import { parseSignedAgentDispatch, AGENT_DISPATCH_SIGNATURE_HEADER } from '@pagespace/lib/auth/agent-dispatch-payload';
import { dispatchThroughChatPipeline } from '../session-tools-runtime';
import { readDispatchScope } from '../session-tools';
import { toolCredentialScope } from '@/lib/ai/core/tool-credential-scope';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
// Through the registry, as the chat routes load tools (the tool modules import
// each other cyclically through it).
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';

type Variant = 'MEMBER' | 'ADMIN' | 'CUSTOM' | 'INHERIT';
type Outcome = 'ok' | 'denied';

interface Fixture {
  driveId: string;
  docId: string;
  doc2Id: string;
  privateId: string;
  folderId: string;
  customRoleId: string;
}

interface ToolCase {
  readonly name: string;
  readonly run: (ctx: ToolExecutionContext, f: Fixture) => Promise<unknown>;
  /** Only for reads whose RESULT differs by role (search): what is visible. */
  readonly fingerprint?: (result: unknown) => unknown;
}

// Executes a real tool the way the AI SDK does: args + experimental_context.
const exec = async (
  t: { execute?: (...args: never[]) => unknown },
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<unknown> => {
  const execute = t.execute as unknown as (a: unknown, o: unknown) => Promise<unknown>;
  return execute(args, { toolCallId: createId(), messages: [], experimental_context: ctx });
};

// Ordered so no earlier write removes a later call's target.
const TOOLS: readonly ToolCase[] = [
  { name: 'read page', run: (c, f) => exec(pageSpaceTools.read_page, { title: 'doc', pageId: f.docId }, c) },
  { name: 'read private page', run: (c, f) => exec(pageSpaceTools.read_page, { title: 'private', pageId: f.privateId }, c) },
  {
    name: 'search',
    run: (c, f) => exec(pageSpaceTools.regex_search, { driveId: f.driveId, pattern: 'ceilingparity', searchIn: 'both', maxResults: 50, contentTypes: ['documents'] }, c),
    fingerprint: (r) => {
      const results = (r as { results?: Array<{ title?: string }> }).results ?? [];
      return results.map((x) => x.title).sort();
    },
  },
  { name: 'edit page', run: (c, f) => exec(pageSpaceTools.replace_lines, { title: 'doc', pageId: f.docId, startLine: 1, content: 'ceilingparity edited' }, c) },
  { name: 'create page (drive root)', run: (c, f) => exec(pageSpaceTools.create_page, { driveId: f.driveId, title: 'Created by tool', type: 'DOCUMENT' }, c) },
  { name: 'share/permissions — create drive role', run: (c, f) => exec(pageSpaceTools.create_drive_role, { driveId: f.driveId, name: `Role ${createId()}` }, c) },
  { name: 'move page', run: (c, f) => exec(pageSpaceTools.move_page, { title: 'doc', pageId: f.docId, newParentId: f.folderId, position: 1 }, c) },
  { name: 'delete page', run: (c, f) => exec(pageSpaceTools.trash_page, { id: f.doc2Id, withChildren: true }, c) },
  { name: 'drive manage — rename drive', run: (c, f) => exec(pageSpaceTools.rename_drive, { currentName: 'x', driveId: f.driveId, name: `Renamed ${createId()}` }, c) },
];

/**
 * What each role may do, pinned — so parity can never be two matching failures.
 * A MEMBER may create at the drive root (user parity) but not edit, move,
 * delete or administer; the custom role grants view+edit on `doc` only — no
 * drive-wide edit, so no root-page create (#2627, the same answer a human
 * member bound by the role gets); ADMIN and INHERIT (the owner's own access)
 * may do everything.
 */
const EXPECTED: Readonly<Record<Variant, Readonly<Record<string, Outcome>>>> = {
  MEMBER: {
    'read page': 'ok', 'read private page': 'denied', search: 'ok', 'edit page': 'denied', 'create page (drive root)': 'ok',
    'share/permissions — create drive role': 'denied', 'move page': 'denied', 'delete page': 'denied', 'drive manage — rename drive': 'denied',
  },
  CUSTOM: {
    'read page': 'ok', 'read private page': 'denied', search: 'ok', 'edit page': 'ok', 'create page (drive root)': 'denied',
    'share/permissions — create drive role': 'denied', 'move page': 'denied', 'delete page': 'denied', 'drive manage — rename drive': 'denied',
  },
  ADMIN: {
    'read page': 'ok', 'read private page': 'ok', search: 'ok', 'edit page': 'ok', 'create page (drive root)': 'ok',
    'share/permissions — create drive role': 'ok', 'move page': 'ok', 'delete page': 'ok', 'drive manage — rename drive': 'ok',
  },
  INHERIT: {
    'read page': 'ok', 'read private page': 'ok', search: 'ok', 'edit page': 'ok', 'create page (drive root)': 'ok',
    'share/permissions — create drive role': 'ok', 'move page': 'ok', 'delete page': 'ok', 'drive manage — rename drive': 'ok',
  },
};

/** Visible search titles by role: MEMBER/CUSTOM never see the private page. */
const SEARCH_TITLES: Readonly<Record<Variant, readonly string[]>> = {
  MEMBER: ['Ceiling doc', 'Ceiling doc 2'],
  CUSTOM: ['Ceiling doc'],
  ADMIN: ['Ceiling doc', 'Ceiling doc 2', 'Ceiling private'],
  INHERIT: ['Ceiling doc', 'Ceiling doc 2', 'Ceiling private'],
};

async function outcomeOf(tc: ToolCase, ctx: ToolExecutionContext, f: Fixture): Promise<{ outcome: Outcome; seen?: unknown; detail: string }> {
  try {
    const result = await tc.run(ctx, f);
    const failed = typeof result === 'object' && result !== null && (result as { success?: unknown }).success === false;
    return {
      outcome: failed ? 'denied' : 'ok',
      ...(tc.fingerprint && !failed ? { seen: tc.fingerprint(result) } : {}),
      detail: JSON.stringify(result).slice(0, 300),
    };
  } catch (error) {
    return { outcome: 'denied', detail: error instanceof Error ? error.message : String(error) };
  }
}

async function fixture(ownerId: string): Promise<Fixture> {
  const drive = await factories.createDrive(ownerId);
  const doc = await factories.createPage(drive.id, { title: 'Ceiling doc', content: 'ceilingparity line one\nline two', position: 1 });
  const doc2 = await factories.createPage(drive.id, { title: 'Ceiling doc 2', content: 'ceilingparity second', position: 2 });
  const priv = await factories.createPage(drive.id, { title: 'Ceiling private', content: 'ceilingparity secret', isPrivate: true, position: 3 });
  const folder = await factories.createPage(drive.id, { title: 'Ceiling folder', type: 'FOLDER', content: '', position: 4 });
  const [role] = await db
    .insert(driveRoles)
    .values({ driveId: drive.id, name: `Doc editor ${createId()}`, permissions: { [doc.id]: { canView: true, canEdit: true, canShare: false } } })
    .returning();
  return { driveId: drive.id, docId: doc.id, doc2Id: doc2.id, privateId: priv.id, folderId: folder.id, customRoleId: role.id };
}

function rowFor(variant: Variant, f: Fixture): { role: 'ADMIN' | 'MEMBER' | null; customRoleId: string | null; scope: string } {
  switch (variant) {
    case 'MEMBER': return { role: 'MEMBER', customRoleId: null, scope: `drive:${f.driveId}:member` };
    case 'ADMIN': return { role: 'ADMIN', customRoleId: null, scope: `drive:${f.driveId}:admin` };
    case 'CUSTOM': return { role: 'MEMBER', customRoleId: f.customRoleId, scope: `drive:${f.driveId}:role:${f.customRoleId}` };
    case 'INHERIT': return { role: null, customRoleId: null, scope: `drive:${f.driveId}` };
  }
}

async function contextFor(token: string, userId: string): Promise<ToolExecutionContext> {
  const request = new Request('http://localhost/api/ai/page-agents/consult', { headers: { authorization: `Bearer ${token}` } });
  const auth = await authenticateRequestWithOptions(request, { allow: ['mcp', 'oauth'] });
  if (isAuthError(auth)) throw new Error(`credential did not authenticate: ${auth.error.status}`);
  expect(auth.userId).toBe(userId);
  return { userId: auth.userId, ...toolCredentialScope(auth) } as ToolExecutionContext;
}

async function mintMcp(userId: string, driveId: string, row: { role: 'ADMIN' | 'MEMBER' | null; customRoleId: string | null }): Promise<string> {
  const mcp = generateToken('mcp');
  const [key] = await db
    .insert(mcpTokens)
    .values({ userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'ceiling key', isScoped: true })
    .returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role: row.role, customRoleId: row.customRoleId });
  return mcp.token;
}

async function mintOAuth(userId: string, scopes: string[]): Promise<string> {
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId: `app_${createId()}`,
      name: 'Ceiling App',
      clientType: 'public',
      redirectUris: ['https://ceiling.example/callback'],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['profile', 'drive', 'drive:member', 'drive:admin', 'offline_access'],
      ownerUserId: userId,
      verified: false,
    })
    .returning();
  const access = generateToken('ps_at');
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash,
    tokenPrefix: access.tokenPrefix,
    familyId: createId(),
    clientId: client.id,
    userId,
    scopes,
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

beforeAll(async () => {
  await ensureTestDb();
});

describe.each<Variant>(['MEMBER', 'ADMIN', 'CUSTOM', 'INHERIT'])('agent-tool ceiling parity, real database (%s)', (variant) => {
  let userId: string;

  beforeAll(async () => {
    userId = (await factories.createUser()).id;
  });

  it('an mcp_ key and an OAuth grant with the same drive and role get the same, pinned tool outcomes; the owner\'s session gets everything', async () => {
    const runAll = async (ctxFor: (f: Fixture) => Promise<ToolExecutionContext>) => {
      const f = await fixture(userId);
      const ctx = await ctxFor(f);
      const out: Record<string, { outcome: Outcome; seen?: unknown; detail: string }> = {};
      for (const tc of TOOLS) out[tc.name] = await outcomeOf(tc, ctx, f);
      return out;
    };

    const viaKey = await runAll(async (f) => contextFor(await mintMcp(userId, f.driveId, rowFor(variant, f)), userId));
    const viaGrant = await runAll(async (f) => contextFor(await mintOAuth(userId, [rowFor(variant, f).scope]), userId));
    const viaSession = await runAll(async () => ({ userId } as ToolExecutionContext));

    const outcomes = (run: typeof viaKey) => Object.fromEntries(TOOLS.map((tc) => [tc.name, run[tc.name].outcome]));
    const details = (run: typeof viaKey) => JSON.stringify(Object.fromEntries(TOOLS.map((tc) => [tc.name, run[tc.name].detail])), null, 1);

    expect(outcomes(viaSession), `session control: ${details(viaSession)}`).toEqual(Object.fromEntries(TOOLS.map((tc) => [tc.name, 'ok'])));
    expect(outcomes(viaKey), `mcp_ key: ${details(viaKey)}`).toEqual(EXPECTED[variant]);
    expect(outcomes(viaGrant), `OAuth grant: ${details(viaGrant)}`).toEqual(EXPECTED[variant]);
    for (const tc of TOOLS.filter((t) => t.fingerprint)) {
      expect(viaKey[tc.name].seen, `${tc.name} via mcp_ key`).toEqual(SEARCH_TITLES[variant]);
      expect(viaGrant[tc.name].seen, `${tc.name} via OAuth grant`).toEqual(SEARCH_TITLES[variant]);
    }
  }, 120_000);
});

describe('a profile-only OAuth token (no drive scope)', () => {
  it('is denied every tool that touches drive content', async () => {
    const userId = (await factories.createUser()).id;
    const f = await fixture(userId);
    const token = await mintOAuth(userId, ['profile']);
    // The door already refuses it on every tool-executing route; the tool layer
    // must refuse it on its own too (defence in depth for any context built
    // from a profile principal).
    const door = await authenticateRequestWithOptions(
      new Request('http://localhost/api/ai/page-agents/consult', { headers: { authorization: `Bearer ${token}` } }),
      { allow: ['mcp', 'oauth'] },
    );
    expect(isAuthError(door)).toBe(true);
    const details = await validateOAuthAccessToken(token);
    if (!details) throw new Error('profile token did not validate');
    const ctx = { userId, ...toolCredentialScope({ ...details, tokenType: 'oauth' }) } as ToolExecutionContext;
    for (const tc of TOOLS) {
      const result = await outcomeOf(tc, ctx, f);
      expect(result.outcome, `${tc.name}: ${result.detail}`).toBe('denied');
    }
  }, 60_000);
});

describe('the agent-dispatch hop carries the ROLE ceiling, not just the drive list', () => {
  /**
   * spawn_session/send_session hand a worker turn to /api/internal/agent-dispatch
   * as a signed payload; the worker runs under SERVICE auth built from it. This
   * drives the real chain end to end — the caller's context → the scope the
   * session tools sign → the exact bytes on the wire → signature verification →
   * the live service principal → the worker's tool context — and runs the tools
   * there. The route's own hand-off of the payload fields is pinned in its suite.
   */
  const HOP_TOOLS = ['read private page', 'edit page', 'share/permissions — create drive role', 'drive manage — rename drive'];

  it.each(['mcp_ key', 'OAuth grant'] as const)('a worker dispatched from a MEMBER %s keeps MEMBER caps', async (kind) => {
    vi.stubEnv('WEB_APP_URL', 'http://localhost:3000');
    vi.stubEnv('REALTIME_BROADCAST_SECRET', 'test-realtime-broadcast-secret-32-chars-minimum-length');
    const userId = (await factories.createUser()).id;
    const f = await fixture(userId);
    const row = rowFor('MEMBER', f);
    const token = kind === 'mcp_ key' ? await mintMcp(userId, f.driveId, row) : await mintOAuth(userId, [row.scope]);
    const callerCtx = await contextFor(token, userId);

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const outcome = await dispatchThroughChatPipeline({
        conversationId: createId(), agentPageId: createId(), input: 'hi', userId, depth: 1, wait: false,
        scope: readDispatchScope(callerCtx),
      });
      expect(outcome).toEqual({ ok: true, waited: false });
    } finally {
      vi.unstubAllGlobals();
    }
    const init = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }])[1];
    const parsed = parseSignedAgentDispatch(init.headers[AGENT_DISPATCH_SIGNATURE_HEADER], init.body);
    if (!parsed.ok) throw new Error(`dispatch did not verify: ${parsed.reason}`);

    const worker = await loadServicePrincipal({
      userId: parsed.payload.actingUserId,
      service: 'agent-dispatch',
      allowedDriveIds: parsed.payload.allowedDriveIds,
      originatingCeiling: parsed.payload.originatingCeiling,
      originatingMcpTokenId: parsed.payload.originatingMcpTokenId,
    });
    if (!worker) throw new Error('worker principal did not load');
    const workerCtx = { userId: worker.userId, ...toolCredentialScope(worker) } as ToolExecutionContext;

    for (const tc of TOOLS.filter((t) => HOP_TOOLS.includes(t.name))) {
      const result = await outcomeOf(tc, workerCtx, f);
      expect(result.outcome, `${kind} worker — ${tc.name}: ${result.detail}`).toBe('denied');
    }
    // Control: what the worker IS allowed still works across the hop.
    const read = await outcomeOf(TOOLS[0], workerCtx, f);
    expect(read.outcome, read.detail).toBe('ok');
  }, 60_000);

  it('a dispatch signed by an older sender (legacy originatingMcpTokenId only) keeps its key\'s ceiling instead of widening', async () => {
    const userId = (await factories.createUser()).id;
    const worker = await loadServicePrincipal({ userId, service: 'agent-dispatch', allowedDriveIds: ['drive-a'], originatingMcpTokenId: 'mcp-token-legacy' });
    expect(worker?.originatingCeiling).toEqual({ kind: 'mcp', tokenId: 'mcp-token-legacy' });
    expect(toolCredentialScope(worker!).credentialCeiling).toEqual({ kind: 'mcp', tokenId: 'mcp-token-legacy' });
  });
});
