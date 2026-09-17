/**
 * A deferred run executes under the ceiling of the credential that AUTHORED it
 * (Sign in with PageSpace, Phase 2b — deferred agent runs).
 *
 * A workflow persists `credentialCeiling` when a drive-scoped credential writes
 * it; `executeWorkflow` — the one function every cron, manual, task-trigger,
 * calendar-trigger and webhook run goes through — re-applies that ceiling to the
 * run's tool context and refuses the run once the credential no longer works.
 *
 * Real: Postgres, the executor, the deterministic tool registry and every
 * permission resolver (the page write's object storage is stubbed). The user
 * OWNS both drives, so every refusal is the ceiling, never the user's own ACL.
 *
 * Requires DATABASE_URL → a migrated Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { workflows, type StoredCredentialCeiling } from '@pagespace/db/schema/workflows';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

vi.mock('@/lib/websocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket')>()),
  broadcastPageEvent: vi.fn(async () => undefined),
  broadcastDriveEvent: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'version', contentRef: 'snapshot', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));

import { executeWorkflow } from '../workflow-executor';
import { pages } from '@pagespace/db/schema/core';

type Role = 'ADMIN' | 'MEMBER';

async function mcpKey(userId: string, driveId: string, role: Role): Promise<StoredCredentialCeiling & { kind: 'mcp' }> {
  const mcp = generateToken('mcp');
  const [key] = await db.insert(mcpTokens).values({ userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'workflow key', isScoped: true }).returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role });
  return { kind: 'mcp', tokenId: key.id };
}

async function oauthGrant(userId: string, driveId: string, role: Role): Promise<StoredCredentialCeiling & { kind: 'oauth'; familyId: string }> {
  const [client] = await db.insert(oauthClients).values({
    clientId: `app_${createId()}`, name: 'Workflow App', clientType: 'public', redirectUris: ['https://workflow.example/callback'],
    allowedGrantTypes: ['authorization_code'], allowedScopes: ['drive:member', 'drive:admin'], ownerUserId: userId, verified: false,
  }).returning();
  const access = generateToken('ps_at');
  const familyId = createId();
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId, clientId: client.id, userId,
    scopes: [`drive:${driveId}:${role.toLowerCase()}`], tokenVersion: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return { kind: 'oauth', driveScopes: [{ driveId, role, customRoleId: null }], familyId };
}

/** A one-step deterministic workflow that rewrites the first line of `docId`, authored under `ceiling`. */
async function runEdit(userId: string, driveId: string, docId: string, ceiling: StoredCredentialCeiling | null) {
  const [workflow] = await db.insert(workflows).values({
    driveId,
    createdBy: userId,
    name: `ceiling ${createId()}`,
    prompt: '',
    steps: [{ kind: 'tool', toolName: 'replace_lines', args: { title: 'doc', pageId: docId, startLine: 1, content: 'edited by workflow' } }],
    contextPageIds: [],
    timezone: 'UTC',
    triggerType: 'cron',
    cronExpression: '0 0 * * *',
    isEnabled: false,
    credentialCeiling: ceiling,
  }).returning();
  return executeWorkflow({
    workflowId: workflow.id,
    workflowName: workflow.name,
    driveId: workflow.driveId,
    createdBy: workflow.createdBy,
    agentPageId: null,
    prompt: '',
    steps: workflow.steps,
    contextPageIds: [],
    instructionPageId: null,
    timezone: 'UTC',
    source: { table: 'manual', id: null, triggerAt: null },
  });
}

async function edited(docId: string): Promise<boolean> {
  const [row] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, docId));
  return (row?.content ?? '').includes('edited by workflow');
}

async function world() {
  const user = await factories.createUser();
  const x = await factories.createDrive(user.id);
  const y = await factories.createDrive(user.id);
  const docX = await factories.createPage(x.id, { title: 'Doc X', content: 'original line' });
  const docY = await factories.createPage(y.id, { title: 'Doc Y', content: 'original line' });
  return { userId: user.id, x: x.id, y: y.id, docX: docX.id, docY: docY.id };
}

beforeAll(async () => {
  await ensureTestDb();
});

describe('a deferred run executes under its authoring credential\'s ceiling', () => {
  it('control: a workflow authored by the user themself (no ceiling) edits the owner\'s doc', async () => {
    const w = await world();
    const result = await runEdit(w.userId, w.x, w.docX, null);
    expect(result.success, result.error).toBe(true);
    expect(await edited(w.docX)).toBe(true);
  }, 30_000);

  it.each(['mcp_ key', 'OAuth grant'] as const)('an ADMIN %s authored it: edits in its drive, refused in the owner\'s other drive', async (kind) => {
    const w = await world();
    const ceiling = kind === 'mcp_ key' ? await mcpKey(w.userId, w.x, 'ADMIN') : await oauthGrant(w.userId, w.x, 'ADMIN');
    expect((await runEdit(w.userId, w.x, w.docX, ceiling)).success).toBe(true);
    expect(await edited(w.docX)).toBe(true);
    expect((await runEdit(w.userId, w.x, w.docY, ceiling)).success).toBe(false);
    expect(await edited(w.docY)).toBe(false);
  }, 30_000);

  it.each(['mcp_ key', 'OAuth grant'] as const)('a MEMBER %s authored it: capped at MEMBER though the user owns the drive', async (kind) => {
    const w = await world();
    const ceiling = kind === 'mcp_ key' ? await mcpKey(w.userId, w.x, 'MEMBER') : await oauthGrant(w.userId, w.x, 'MEMBER');
    const result = await runEdit(w.userId, w.x, w.docX, ceiling);
    expect(result.success).toBe(false);
    expect(await edited(w.docX)).toBe(false);
  }, 30_000);

  it('a revoked mcp_ key\'s workflow does not run', async () => {
    const w = await world();
    const ceiling = await mcpKey(w.userId, w.x, 'ADMIN');
    await db.update(mcpTokens).set({ revokedAt: new Date() }).where(eq(mcpTokens.id, ceiling.tokenId));
    const result = await runEdit(w.userId, w.x, w.docX, ceiling);
    expect(result.success).toBe(false);
    expect(await edited(w.docX)).toBe(false);
  }, 30_000);

  it('a revoked OAuth grant\'s workflow does not run', async () => {
    const w = await world();
    const ceiling = await oauthGrant(w.userId, w.x, 'ADMIN');
    await db.update(oauthAccessTokens).set({ revokedAt: new Date(), revokedReason: 'user_revoked' }).where(eq(oauthAccessTokens.familyId, ceiling.familyId));
    const result = await runEdit(w.userId, w.x, w.docX, ceiling);
    expect(result.success).toBe(false);
    expect(await edited(w.docX)).toBe(false);
  }, 30_000);
});
