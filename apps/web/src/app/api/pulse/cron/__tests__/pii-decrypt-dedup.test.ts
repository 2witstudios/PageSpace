import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// POST /api/pulse/cron — PII decryption dedup (GDPR #965 perf remediation
// round 2). The per-user summary build decrypts sender/member PII through
// decryptFieldValuesOnce, batched once per section per unique stored value,
// instead of one decryptField call per row. This exercises the unread-DMs
// section end to end: one sender repeated across many unread messages must
// decrypt once and surface plaintext in the persisted contextData.
//
// Uses the same fixture-based fake DB as ../../__tests__/task-fixture-db.
// ============================================================================

const h = vi.hoisted(() => ({
  tableRows: new Map<unknown, Record<string, unknown>[]>(),
  accessiblePageIds: [] as string[],
  insertValuesMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() } },
}));

vi.mock('@pagespace/lib/billing/automation-preferences', () => ({
  filterPulseEligible: vi.fn((ids: string[]) => ids),
}));

vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn(() => ''),
  getUserTimeOfDay: vi.fn(() => ({ timeOfDay: 'morning' })),
  getStartOfTodayInTimezone: vi.fn(() => new Date('2024-01-10T00:00:00.000Z')),
  normalizeTimezone: vi.fn(() => 'UTC'),
  formatDateInTimezone: vi.fn(() => 'today'),
}));

vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  BACKGROUND_LIGHT_MODEL: 'anthropic/claude-test',
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'anthropic', modelName: 'anthropic/claude-test' }),
  isProviderError: vi.fn(() => false),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'Good morning! Everything looks fine.',
    usage: { inputTokens: 10, outputTokens: 10 },
    steps: [],
  }),
}));

vi.mock('../../calendar-context', () => ({
  fetchCalendarContext: vi.fn().mockResolvedValue({
    happeningNow: [], upcomingToday: [], tomorrow: [], pendingInvites: [], allEvents: [],
  }),
}));

vi.mock('@pagespace/lib/permissions/accessible-page-ids', () => ({
  accessiblePageIds: vi.fn(() => Promise.resolve(h.accessiblePageIds)),
}));

vi.mock('@pagespace/lib/content/activity-diff-utils', () => ({
  groupActivitiesForDiff: vi.fn(() => []),
}));
vi.mock('@pagespace/lib/content/version-resolver', () => ({
  resolveStackedVersionContent: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('@pagespace/lib/content/diff-generator', () => ({
  generateDiffsWithinBudget: vi.fn(() => []),
  calculateDiffBudget: vi.fn(() => 1000),
}));
vi.mock('@pagespace/lib/services/page-content-store', () => ({
  readPageContent: vi.fn().mockResolvedValue(null),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => 0),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, holdId: 'hold-1' }),
}));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: vi.fn().mockResolvedValue(undefined) }));

// Wrap (not replace) the real decryptFieldValuesOnce so call counts and batch
// contents can be asserted at the route's call boundary — proves the route
// batches decryption per section instead of one decryptField call per row.
// A bare `vi.spyOn` doesn't work here because `@pagespace/lib` resolves to
// its built CJS dist output, and the inner per-value decrypt (decryptField)
// is a *nested* require inside that compiled module, invisible to any mock
// declared at this level. encryptField/decryptField stay real via the spread.
vi.mock('@pagespace/lib/encryption/field-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/encryption/field-crypto')>();
  return { ...actual, decryptFieldValuesOnce: vi.fn(actual.decryptFieldValuesOnce) };
});

vi.mock('@pagespace/db/db', async () => {
  const { createFixtureSelect } = await import('../../__tests__/task-fixture-db');
  return {
    db: {
      select: createFixtureSelect(h.tableRows),
      insert: vi.fn(() => ({ values: h.insertValuesMock })),
    },
  };
});

vi.mock('@pagespace/db/operators', async () => {
  const { fixtureOperators } = await import('../../__tests__/task-fixture-db');
  return fixtureOperators;
});

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', timezone: 'timezone', name: 'name', email: 'email', subscriptionTier: 'subscriptionTier' },
}));
vi.mock('@pagespace/db/schema/sessions', () => ({
  sessions: { userId: 'userId', type: 'type', revokedAt: 'revokedAt', lastUsedAt: 'lastUsedAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed', title: 'title', content: 'content' },
  drives: { id: 'id', name: 'name', drivePrompt: 'drivePrompt', isTrashed: 'isTrashed', ownerId: 'ownerId' },
  userMentions: { targetUserId: 'targetUserId', createdAt: 'createdAt', mentionedByUserId: 'mentionedByUserId', sourcePageId: 'sourcePageId' },
  chatMessages: { pageId: 'pageId', role: 'role', isActive: 'isActive', createdAt: 'createdAt', userId: 'userId', content: 'content' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: {
    id: 'id', userId: 'userId', actorDisplayName: 'actorDisplayName', actorEmail: 'actorEmail',
    operation: 'operation', resourceType: 'resourceType', resourceId: 'resourceId', pageId: 'pageId',
    resourceTitle: 'resourceTitle', driveId: 'driveId', timestamp: 'timestamp', changeGroupId: 'changeGroupId',
    aiConversationId: 'aiConversationId', isAiGenerated: 'isAiGenerated', contentRef: 'contentRef', contentSnapshot: 'contentSnapshot',
  },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId', acceptedAt: 'acceptedAt' },
  pagePermissions: { userId: 'userId', pageId: 'pageId', grantedBy: 'grantedBy', grantedAt: 'grantedAt' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: {
    pageId: 'pageId', assigneeId: 'assigneeId', userId: 'userId', status: 'status',
    dueDate: 'dueDate', completedAt: 'completedAt', priority: 'priority',
  },
}));
vi.mock('@pagespace/db/schema/social', () => ({
  directMessages: {
    conversationId: 'conversationId', senderId: 'senderId', isRead: 'isRead', isActive: 'isActive',
    parentId: 'parentId', content: 'content', createdAt: 'createdAt',
  },
  dmConversations: { id: 'id', participant1Id: 'participant1Id', participant2Id: 'participant2Id' },
}));
vi.mock('@pagespace/db/schema/dashboard', () => ({
  pulseSummaries: { userId: 'userId', generatedAt: 'generatedAt', summary: 'summary' },
}));
vi.mock('@pagespace/db/schema/automation-preferences', () => ({
  userAutomationPreferences: { userId: 'userId', pulseEnabled: 'pulseEnabled' },
}));

import { POST } from '../route';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';
import { decryptFieldValuesOnce, encryptField } from '@pagespace/lib/encryption/field-crypto';

const USER_ID = 'user-1';
const OTHER_ID = 'user-other';

function setupTables(dmRows: Record<string, unknown>[]) {
  h.tableRows.clear();
  h.accessiblePageIds = [];
  h.tableRows.set(users, [{ id: USER_ID, timezone: 'UTC', name: 'Tester', email: 'tester@example.com', subscriptionTier: 'pro' }]);
  h.tableRows.set(sessions, [{ userId: USER_ID, type: 'user', revokedAt: null, lastUsedAt: new Date() }]);
  h.tableRows.set(dmConversations, [{ id: 'conv-1', participant1Id: USER_ID, participant2Id: OTHER_ID }]);
  h.tableRows.set(directMessages, dmRows);
}

// Joined users.name/email are flattened into the message fixture rows
// (the fixture DB resolves select fields by column name).
const unreadDmRow = (senderName: string, content: string) => ({
  conversationId: 'conv-1',
  senderId: OTHER_ID,
  isRead: false,
  isActive: true,
  parentId: null,
  name: senderName,
  email: 'other@example.com',
  content,
  createdAt: new Date('2024-01-10T08:00:00.000Z'),
});

const makeRequest = () => new Request('https://example.com/api/pulse/cron', { method: 'POST' });

describe('POST /api/pulse/cron — PII decryption dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.insertValuesMock.mockClear();
    h.insertValuesMock.mockResolvedValue(undefined);
  });

  it('decrypts one encrypted sender repeated across unread DMs once and persists plaintext', async () => {
    const encryptedSender = await encryptField('Real Sender');
    setupTables([
      unreadDmRow(encryptedSender, 'first'),
      unreadDmRow(encryptedSender, 'second'),
      unreadDmRow(encryptedSender, 'third'),
    ]);

    const response = await POST(makeRequest());
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.generated).toBe(1);

    expect(h.insertValuesMock).toHaveBeenCalledTimes(1);
    const row = h.insertValuesMock.mock.calls[0][0] as {
      contextData: { messages: { unreadCount: number; recentSenders: string[] } };
    };
    // The repeated sender surfaces as ONE plaintext name in the summary.
    expect(row.contextData.messages.unreadCount).toBe(3);
    expect(row.contextData.messages.recentSenders).toEqual(['Real Sender']);

    // The unread-DMs section made exactly one batched decrypt call carrying
    // the repeated ciphertext (dedup happens inside the helper) — not one
    // decryptField call per row. Emails stay out of the batch because every
    // row has a sender name (the old || short-circuit, preserved).
    const dmBatch = vi
      .mocked(decryptFieldValuesOnce)
      .mock.calls.filter(([values]) => values.includes(encryptedSender));
    expect(dmBatch).toHaveLength(1);
    expect(dmBatch[0][0].filter((v) => v === encryptedSender)).toHaveLength(3);
    expect(dmBatch[0][0]).not.toContain('other@example.com');
  });

  it('falls back to the decrypted email local-part when a sender has no name', async () => {
    const encryptedEmail = await encryptField('fallback@example.com');
    setupTables([
      { ...unreadDmRow('', 'no name on this one'), name: null, email: encryptedEmail },
    ]);

    const response = await POST(makeRequest());
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.generated).toBe(1);

    const row = h.insertValuesMock.mock.calls[0][0] as {
      contextData: { messages: { recentSenders: string[] } };
    };
    expect(row.contextData.messages.recentSenders).toEqual(['fallback']);
  });
});
