// @vitest-environment node
/** Ordinary isolated route/domain tests: real policies and funded reservation; no provider transport or full export. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditHolds } from '@pagespace/db/schema/credits';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { credentialActor, automationActor, HELD_DRIVES } from '@pagespace/lib/permissions/access-actor';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import { credentialExportGate } from '@pagespace/lib/compliance/export/export-sign-in-gate';

const state = vi.hoisted(() => ({ userId: '', authentication: null as VerifiedAuthentication | null, prompt: '' }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: state.userId, authentication: state.authentication, tokenType: 'session' })),
  isAuthError: () => false,
}));
// The factory remains real. Its admitted model reaches this deterministic boundary without SDK/network execution.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(async (input: { messages: readonly { content: string }[] }) => {
    state.prompt = input.messages.map((message) => message.content).join('\n');
    return { text: state.prompt.includes('Retained allowed source') ? 'Retained allowed source' : 'Personal summary', usage: { inputTokens: 1, outputTokens: 1 }, steps: [] };
  }),
}));
// Settlement is outside this source contract. The real funded reservation is checked and cleaned below.
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: async () => ({}) }, discardUsageOutcome: () => {},
  extractOpenRouterCostDollars: () => undefined, extractOpenRouterGenerationIds: () => undefined,
}));

import { POST as generate } from '../generate/route';
import { GET as readPulse } from '../route';
import { pulseSourceOrgIds } from '../calendar-context';
import { BACKGROUND_LIGHT_PROVIDER, BACKGROUND_LIGHT_MODEL } from '@/lib/ai/core/ai-providers-config';
import { createAIProvider } from '@/lib/ai/core/provider-factory';

const model = { provider: BACKGROUND_LIGHT_PROVIDER, modelId: BACKGROUND_LIGHT_MODEL };
let orgId = '';
let personalWalletId = '';
const request = (method: 'GET' | 'POST') => new Request('http://unit.test/api/pulse', {
  method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
});

beforeEach(async () => {
  state.prompt = '';
  state.authentication = { authenticatedAtMs: Date.now(), assurance: 'single_factor' };
  vi.stubEnv('OPENROUTER_DEFAULT_API_KEY', 'fake-isolated-test-key');
  vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:1');
  const user = await factories.createUser({ subscriptionTier: 'free' });
  state.userId = user.id;
  const now = new Date();
  const [wallet] = await db.insert(wallets).values({ userId: user.id, monthlyRemainingCents: 5000, monthlyAllowanceCents: 5000, monthlyPeriodStart: now, monthlyPeriodEnd: new Date(+now + 20 * 86400_000) }).returning();
  personalWalletId = wallet.id;
  const [org] = await db.insert(organizations).values({ name: 'Source admission', slug: `source-${createId()}`, ownerId: user.id, policies: { requireStrongSignIn: true } }).returning();
  orgId = org.id;
  await db.insert(orgMembers).values({ orgId, userId: user.id, role: 'OWNER' });
});

afterEach(async () => {
  await db.delete(drives).where(eq(drives.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(creditHolds).where(eq(creditHolds.userId, state.userId));
  await db.delete(drives).where(eq(drives.ownerId, state.userId));
  await db.delete(users).where(eq(users.id, state.userId));
  vi.unstubAllEnvs();
});

async function previous(summary: string) {
  const now = new Date();
  await db.insert(pulseSummaries).values({ userId: state.userId, summary, type: 'scheduled', orgIds: [orgId], periodStart: now, periodEnd: now, expiresAt: new Date(+now + 86400_000) });
}

describe('Pulse source admission and retained provenance', () => {
  it('Given a prior summary refused for this credential, should omit it before generation', async () => {
    await previous('Credential withheld prior source');
    expect((await (await readPulse(request('GET'))).json()).signInRequired.code).toBe('org_strong_sign_in_required');
    const response = await generate(request('POST'));
    expect(response.status).toBe(200);
    expect(state.prompt).not.toContain('Credential withheld prior source');
    const holds = await db.select().from(creditHolds).where(eq(creditHolds.userId, state.userId));
    expect(holds).toHaveLength(1);
    expect(holds[0].walletId).toBe(personalWalletId);
  });

  it('Given an admitted prior summary whose org forbids the model, should omit it before generation', async () => {
    state.authentication = { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' };
    await db.update(organizations).set({ policies: { providerAllowlist: [] } }).where(eq(organizations.id, orgId));
    await previous('Model withheld prior source');
    const response = await generate(request('POST'));
    expect(response.status).toBe(200);
    expect(state.prompt).not.toContain('Model withheld prior source');
  });

  it('Given an allowed reusable summary, should retain its org on output and withhold the derived row after policy tightens', async () => {
    await db.update(organizations).set({ policies: {} }).where(eq(organizations.id, orgId));
    await previous('Retained allowed source');
    const response = await generate(request('POST'));
    expect(response.status).toBe(200);
    expect(state.prompt).toContain('Retained allowed source');
    const body = await response.json();
    const saved = await db.query.pulseSummaries.findFirst({ where: eq(pulseSummaries.id, body.id) });
    expect(saved?.orgIds).toEqual([orgId]);
    await db.update(organizations).set({ policies: { requireStrongSignIn: true } }).where(eq(organizations.id, orgId));
    const read = await (await readPulse(request('GET'))).json();
    expect(read.summary).toBeNull();
    expect(read.signInRequired.code).toBe('org_strong_sign_in_required');
    expect((await credentialExportGate(credentialActor(state.userId, state.authentication)).derivedContent(saved!.orgIds)).allowed).toBe(false);
  });

  it('Given forbidden attendee and pending RSVP sources, should omit their content from prompt and response while retaining personal content', async () => {
    const drive = await factories.createDrive(state.userId, { orgId, orgVisibility: 'OPEN' });
    const now = Date.now();
    const [event] = await db.insert(calendarEvents).values({ driveId: drive.id, createdById: state.userId, title: 'Withheld attendee content', startAt: new Date(now + 60_000), endAt: new Date(now + 3600_000), visibility: 'ATTENDEES_ONLY' }).returning();
    await db.insert(eventAttendees).values({ eventId: event.id, userId: state.userId, status: 'PENDING' });
    await db.insert(calendarEvents).values({ driveId: null, createdById: state.userId, title: 'Allowed personal content', startAt: new Date(now + 60_000), endAt: new Date(now + 3600_000) });
    const response = await generate(request('POST'));
    expect(response.status).toBe(200);
    expect(state.prompt).not.toContain('Withheld attendee content');
    expect(state.prompt).toContain('Allowed personal content');
    const body = await response.json();
    expect(JSON.stringify(body.contextData)).not.toContain('Withheld attendee content');
    expect(JSON.stringify(body.contextData)).toContain('Allowed personal content');
  });

  it('Given a derived memory page, should retain every transitive org in source provenance', async () => {
    const drive = await factories.createDrive(state.userId);
    const page = await factories.createPage(drive.id);
    await db.insert(userPersonalization).values({ userId: state.userId, bioPageId: page.id, memoryOrgIds: [orgId] });
    expect(await pulseSourceOrgIds({ driveIds: [drive.id], pageIds: [page.id], calendar: { sourceDriveIds: [] } })).toEqual([orgId]);
  });

  it('Given scheduled retained org provenance, should reuse allowed content but still enforce the model policy', async () => {
    await previous('Retained allowed source');
    const { readReusablePulseSummaries } = await import('../source-admission');
    const actor = automationActor(state.userId, 'pulse-cron', HELD_DRIVES);
    expect((await readReusablePulseSummaries(actor, model)).map((row) => row.summary)).toEqual(['Retained allowed source']);
    await db.update(organizations).set({ policies: { providerAllowlist: [] } }).where(eq(organizations.id, orgId));
    expect(await readReusablePulseSummaries(actor, model)).toEqual([]);
    expect(await createAIProvider(state.userId, { selectedProvider: model.provider, selectedModel: model.modelId }, { driveId: null, contentOrgIds: [orgId] })).toMatchObject({ status: 403, code: 'org_policy' });
  });
});
