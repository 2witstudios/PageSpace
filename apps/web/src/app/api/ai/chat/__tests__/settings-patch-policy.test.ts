/**
 * PATCH /api/ai/chat (page AI settings) under the org model allowlists (Spec POL-8). The runtime refusal lives in the
 * provider factory; this is the save-time stop, so a disallowed model is refused with the policy named instead of
 * being stored and then failing every call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getDrivePolicies = vi.hoisted(() => vi.fn());
const applyPageMutation = vi.hoisted(() => vi.fn());
const selectQueue = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock('@pagespace/lib/organizations/policy-reader', () => ({ getDrivePolicies }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: 'user_1' })),
  isAuthError: () => false,
  canPrincipalEditPage: vi.fn(async () => true),
}));
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => selectQueue.rows.shift() ?? [] }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { ai: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn(async () => ({ actorEmail: 'a@b.c', actorDisplayName: 'A' })) }));
vi.mock('@/services/api/page-mutation-service', () => ({ applyPageMutation, PageRevisionMismatchError: class extends Error {} }));
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({ requiresProSubscription: () => false }));

import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';
import { patchAiChatSettings } from '../chat-settings-handlers';

const PAGE_ID = 'page_abcdefghijkl';
const req = (body: unknown) => new Request('https://example.test/api/ai/chat', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (model: string) => patchAiChatSettings(req({ pageId: PAGE_ID, provider: 'zai', model }));

beforeEach(() => {
  vi.clearAllMocks();
  // 1st select: the page; 2nd: the user row used by the tier check.
  selectQueue.rows = [[{ id: PAGE_ID, driveId: 'drive_1' }], [{ role: 'user', subscriptionTier: 'business' }]];
  getDrivePolicies.mockResolvedValue(null);
  applyPageMutation.mockResolvedValue(undefined);
});

describe('saving a model on a page in an org drive', () => {
  it('POL-8 (partial) a model outside the org allowlist is refused 403 with the policy named, and nothing is saved', async () => {
    getDrivePolicies.mockResolvedValue({ orgId: 'org_1', policies: { ...DEFAULT_ORG_POLICIES, modelAllowlist: ['allowed/model'] } });

    const res = await patch('anthropic/claude-x');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'org_policy', policy: 'modelAllowlist' });
    expect(applyPageMutation).not.toHaveBeenCalled();
    expect(getDrivePolicies).toHaveBeenCalledWith('drive_1');
  });

  it('POL-8 (partial) an allowed model is saved; a page in a drive with no org is never restricted', async () => {
    getDrivePolicies.mockResolvedValue({ orgId: 'org_1', policies: { ...DEFAULT_ORG_POLICIES, modelAllowlist: ['anthropic/claude-x'] } });
    expect((await patch('anthropic/claude-x')).status).toBe(200);
    expect(applyPageMutation).toHaveBeenCalledTimes(1);

    selectQueue.rows = [[{ id: PAGE_ID, driveId: 'drive_2' }], [{ role: 'user', subscriptionTier: 'business' }]];
    getDrivePolicies.mockResolvedValue(null);
    expect((await patch('anything/else')).status).toBe(200);
  });
});
