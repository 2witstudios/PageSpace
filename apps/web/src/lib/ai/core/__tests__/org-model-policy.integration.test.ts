/**
 * POL-8 against a REAL Postgres: an org's model and provider allowlists govern every model use inside its drives,
 * read from the org row at the moment of use (no cache), and nothing outside its drives.
 *   - running a model: the provider factory refuses a model or provider the drive's org does not allow, including a
 *     call that used to name no drive (the Zoom summary, billed to the meeting's destination drive);
 *   - saving one: an agent page's provider/model write (every route, AI tool and chat echo goes through
 *     applyPageMutation) and an agent page created with a chosen model are refused, and nothing is written;
 *   - offering one: the model list a drive's picker gets is the org's allowlist;
 *   - reading org content with one: a person's background model (memory discovery, pulse) leaves out the drives,
 *     and the pages in them, whose org does not allow it;
 *   - bringing one in: moving an agent page, or a whole drive, into an org that does not allow its model is refused;
 * Only the model network call (`generateText`), page-version blob storage and the request's session are stubbed;
 * every policy, drive, page and user row is real. Every row is deleted; the pool is ended. The payer-aware tier the
 * shared pro-model gate (model-entitlement.ts) asks for is proven against real wallets in lib
 * (billing/__tests__/entitlement-tier.integration.test.ts), where organizations can be switched on.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'test-version', contentRef: 'test-ref', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:test-${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
const generateText = vi.hoisted(() => vi.fn(async () => ({ text: '- decided', usage: { inputTokens: 1, outputTokens: 1 } })));
vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText }));
// The bulk-copy route authenticates the drive owner's session; every permission check after that is real.
const authed = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: authed.userId, tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0 })),
  isAuthError: vi.fn(() => false),
}));
// Organizations are live for this app's own reads (the move-in route answers); the lib dist reads its own constant.
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/lib/websocket', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/websocket')>()), broadcastPageEvent: vi.fn(async () => undefined) }));

import { createAIProvider, isProviderError } from '../provider-factory';
import { resolveProviderModel } from '../ai-providers-config';
import { offeredModels, scopeReadableByModel } from '../org-model-policy';
import { applyPageMutation, OrgModelPolicyError } from '@/services/api/page-mutation-service';
import { pageService } from '@/services/api/page-service';
import { generateTranscriptSummary } from '@/lib/integrations/zoom/generate-summary';
import { POST as bulkCopy } from '@/app/api/pages/bulk-copy/route';
import { PUT as moveDriveIn } from '@/app/api/drives/[driveId]/org/route';
import { movePagesToDrive } from '@/services/api/page-cross-drive-move-service';

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let dbAvailable = false;
const originalKey = process.env.OPENROUTER_DEFAULT_API_KEY;

// The two models of the test, both in the static catalog under the same vendor.
const ALLOWED = { provider: 'openai', model: 'openai/gpt-6-luna' };
const REFUSED = { provider: 'openai', model: 'openai/gpt-6-sol' };

interface World { owner: string; orgId: string; orgDrive: string; agentPage: string; orgDocPage: string; personalDrive: string }
let w: World;

const setPolicies = (policies: Record<string, unknown>) => db.update(organizations).set({ policies }).where(eq(organizations.id, w.orgId));
const agentRow = async () => (await db.select({ aiProvider: pages.aiProvider, aiModel: pages.aiModel }).from(pages).where(eq(pages.id, w.agentPage)))[0];
const saveModel = (pair: { provider: string; model: string }) => applyPageMutation({
  pageId: w.agentPage,
  operation: 'agent_config_update',
  updates: { aiProvider: pair.provider, aiModel: pair.model },
  updatedFields: ['aiProvider', 'aiModel'],
  context: { userId: w.owner, resourceType: 'agent' },
});

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('org-model-policy.integration.test.ts', error);
  }
});

beforeEach(async () => {
  process.env.OPENROUTER_DEFAULT_API_KEY = 'test-key';
  generateText.mockClear();
  if (!dbAvailable) return;
  const owner = await factories.createUser({ currentAiProvider: ALLOWED.provider, currentAiModel: ALLOWED.model });
  created.userIds.push(owner.id);
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id, policies: { modelAllowlist: [ALLOWED.model] } });
  await db.insert(orgMembers).values({ orgId, userId: owner.id, role: 'OWNER' });
  await factories.createOrgSubscription(orgId, { status: 'active' });
  const orgDrive = (await factories.createDrive(owner.id, { orgId, orgVisibility: 'RESTRICTED' })).id;
  const personalDrive = (await factories.createDrive(owner.id)).id;
  created.driveIds.push(orgDrive, personalDrive);
  const agentPage = (await factories.createPage(orgDrive, { type: 'AI_CHAT', aiProvider: ALLOWED.provider, aiModel: ALLOWED.model })).id;
  const orgDocPage = (await factories.createPage(orgDrive)).id;
  w = { owner: owner.id, orgId, orgDrive, agentPage, orgDocPage, personalDrive };
  authed.userId = owner.id;
});

afterEach(async () => {
  if (originalKey === undefined) delete process.env.OPENROUTER_DEFAULT_API_KEY;
  else process.env.OPENROUTER_DEFAULT_API_KEY = originalKey;
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('POL-8 the org model and provider allowlists govern every model use in its drives: running, saving, copying, moving in, offering and reading', () => {
  it('running: a model or provider the drive\'s org does not allow is refused 403 naming the policy; an allowed one runs; no drive, or a personal drive, is never restricted', async () => {
    const run = (driveId: string | null, pair: { provider: string; model: string }) =>
      createAIProvider(w.owner, { selectedProvider: pair.provider, selectedModel: pair.model }, { driveId });

    expect(await run(w.orgDrive, REFUSED)).toMatchObject({ status: 403, code: 'org_policy', policy: 'modelAllowlist' });
    expect(isProviderError(await run(w.orgDrive, ALLOWED))).toBe(false);
    expect(isProviderError(await run(w.personalDrive, REFUSED))).toBe(false);
    expect(isProviderError(await run(null, REFUSED))).toBe(false);

    await setPolicies({ providerAllowlist: ['anthropic'] });
    expect(await run(w.orgDrive, ALLOWED)).toMatchObject({ status: 403, policy: 'providerAllowlist' });
  });

  it('running: a change applies to the very next call, in both directions, with no restart', async () => {
    const run = () => createAIProvider(w.owner, { selectedProvider: REFUSED.provider, selectedModel: REFUSED.model }, { driveId: w.orgDrive });
    expect(isProviderError(await run())).toBe(true);
    await setPolicies({});
    expect(isProviderError(await run())).toBe(false);
    await setPolicies({ modelAllowlist: [] });
    expect(isProviderError(await run())).toBe(true);
  });

  it('running: a Zoom summary billed to an org drive uses only a model that org allows — refused, no model is called', async () => {
    const zoom = () => generateTranscriptSummary(w.owner, 'transcript', { driveId: w.orgDrive, userId: w.owner });
    const { provider, model } = resolveProviderModel(undefined, undefined, ALLOWED.provider, ALLOWED.model);

    await setPolicies({ modelAllowlist: [REFUSED.model] });
    expect(await zoom()).toBe('');
    expect(generateText).not.toHaveBeenCalled();

    await setPolicies({ modelAllowlist: [model], providerAllowlist: [provider] });
    expect(await zoom()).toBe('- decided');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('saving: an agent page\'s provider/model write to a model the org does not allow is refused and nothing is written; an allowed one is saved', async () => {
    await expect(saveModel(REFUSED)).rejects.toBeInstanceOf(OrgModelPolicyError);
    await expect(saveModel(REFUSED)).rejects.toMatchObject({ refusal: { status: 403, policy: 'modelAllowlist' } });
    expect(await agentRow()).toEqual({ aiProvider: ALLOWED.provider, aiModel: ALLOWED.model });

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    await saveModel(REFUSED);
    expect(await agentRow()).toEqual({ aiProvider: REFUSED.provider, aiModel: REFUSED.model });
  });

  it('saving: an agent page created in an org drive with a model the org does not allow is refused 403 and not created', async () => {
    const before = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive));
    const result = await pageService.createPage(w.owner, { title: 'Analyst', type: 'AI_CHAT', driveId: w.orgDrive, aiProvider: REFUSED.provider, aiModel: REFUSED.model });

    expect(result).toMatchObject({ success: false, status: 403 });
    expect(await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive))).toHaveLength(before.length);
    expect(await pageService.createPage(w.owner, { title: 'Analyst', type: 'AI_CHAT', driveId: w.orgDrive, aiProvider: ALLOWED.provider, aiModel: ALLOWED.model })).toMatchObject({ success: true });
  });

  it('saving: copying an agent page into an org drive that does not allow its model is refused 403 and copies nothing; one it allows is copied', async () => {
    const outsideAgent = (await factories.createPage(w.personalDrive, { type: 'AI_CHAT', aiProvider: REFUSED.provider, aiModel: REFUSED.model })).id;
    const copy = () => bulkCopy(new Request('http://localhost/api/pages/bulk-copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageIds: [outsideAgent], targetDriveId: w.orgDrive, targetParentId: null, includeChildren: false }),
    }));
    const orgPages = async () => (await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive))).length;
    const before = await orgPages();

    const refused = await copy();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'org_policy', policy: 'modelAllowlist' });
    expect(await orgPages()).toBe(before);

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    expect((await copy()).status).toBe(200);
    expect(await orgPages()).toBe(before + 1);
  });

  it('bringing in: moving an agent page into an org drive that does not allow its model is refused 403 naming the policy, and nothing moves', async () => {
    const outsideAgent = (await factories.createPage(w.personalDrive, { type: 'AI_CHAT', aiProvider: REFUSED.provider, aiModel: REFUSED.model })).id;
    const move = () => movePagesToDrive({
      pageIds: [outsideAgent],
      targetDriveId: w.orgDrive,
      targetParentId: null,
      userId: w.owner,
      authorize: { isDriveInScope: async () => true, canAdministerDrive: async () => true, canEditPage: async () => true },
    });
    const driveOf = async () => (await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, outsideAgent)))[0]?.driveId;

    expect(await move()).toMatchObject({ success: false, code: 'ORG_POLICY', status: 403, policy: 'modelAllowlist' });
    expect(await driveOf()).toBe(w.personalDrive);

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    expect(await move()).toMatchObject({ success: true });
    expect(await driveOf()).toBe(w.orgDrive);
  });

  it('bringing in: moving a drive whose agent the org does not allow into the org is refused 403 naming the policy, and the drive stays out', async () => {
    const outsideDrive = (await factories.createDrive(w.owner)).id;
    created.driveIds.push(outsideDrive);
    await factories.createPage(outsideDrive, { type: 'AI_CHAT', aiProvider: REFUSED.provider, aiModel: REFUSED.model });
    const moveIn = () => moveDriveIn(new Request(`http://localhost/api/drives/${outsideDrive}/org`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: w.orgId }),
    }), { params: Promise.resolve({ driveId: outsideDrive }) });
    const orgOf = async () => (await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, outsideDrive)))[0]?.orgId;

    const refused = await moveIn();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'org_policy', policy: 'modelAllowlist' });
    expect(await orgOf()).toBeNull();

    await setPolicies({ modelAllowlist: [ALLOWED.model, REFUSED.model] });
    expect((await moveIn()).status).toBe(200);
    expect(await orgOf()).toBe(w.orgId);
  });

  it('offering: the model list an org drive offers is its allowlist; a personal drive offers the whole catalog (null)', async () => {
    await setPolicies({ modelAllowlist: [ALLOWED.model], providerAllowlist: [ALLOWED.provider] });
    expect(await offeredModels(w.orgDrive)).toEqual({ [ALLOWED.provider]: [ALLOWED.model] });
    expect(await offeredModels(w.personalDrive)).toBeNull();
    expect(await offeredModels(null)).toBeNull();
  });

  it('reading: a person\'s background model reads only drives, and pages in drives, whose org allows it', async () => {
    const personalPage = (await factories.createPage(w.personalDrive)).id;
    const scope = { driveIds: [w.orgDrive, w.personalDrive], pageIds: [w.orgDocPage, personalPage] };

    expect(await scopeReadableByModel({ provider: REFUSED.provider, modelId: REFUSED.model }, scope)).toEqual({ driveIds: [w.personalDrive], pageIds: [personalPage] });
    const allowed = await scopeReadableByModel({ provider: ALLOWED.provider, modelId: ALLOWED.model }, scope);
    expect(allowed.driveIds).toEqual([w.orgDrive, w.personalDrive]);
    expect([...allowed.pageIds].sort()).toEqual([w.orgDocPage, personalPage].sort());
  });
});
