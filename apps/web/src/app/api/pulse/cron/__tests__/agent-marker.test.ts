import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// POST /api/pulse/cron — Agent Signup Phase 2c. Every other user's name that
// enters the Pulse summariser's prompt is labelled when that user is an agent
// account (`modelContextUserLabel`, from the live users.accountType — never
// the name). Human names reach the prompt byte-identical.
//
// Uses the fixture DB of ../../__tests__/task-fixture-db: joined users columns
// (name, email, accountType) are flattened into each table's fixture rows.
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
  BACKGROUND_LIGHT_PROVIDER: 'anthropic',
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
    happeningNow: [], upcomingToday: [], tomorrow: [], pendingInvites: [], allEvents: [], sourceDriveIds: [],
  }),
  pulseSourceOrgIds: vi.fn(async () => []),
}));

// POL-8: the scope the digest's model may read. Here: all of it.
vi.mock('@/lib/ai/core/org-model-policy', () => ({
  scopeReadableByModel: vi.fn(async (_use: unknown, scope: { driveIds: readonly string[]; pageIds?: readonly string[] }) => ({ driveIds: [...scope.driveIds], pageIds: [...(scope.pageIds ?? [])] })),
}));
// The one member-drive set (org-aware).
vi.mock('@pagespace/lib/permissions/member-drives', () => ({
  getMemberDriveIds: vi.fn(async () => ['drive-1']),
}));

vi.mock('@pagespace/lib/permissions/accessible-page-ids', () => ({
  accessiblePageIds: vi.fn(() => Promise.resolve(h.accessiblePageIds)),
}));

vi.mock('@pagespace/lib/content/activity-diff-utils', () => ({
  groupActivitiesForDiff: vi.fn(() => []),
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'convId', contextId: 'contextId', type: 'convType' },
  messages: {
    id: 'msgId', conversationId: 'conversationId', role: 'role', isActive: 'isActive',
    createdAt: 'createdAt', userId: 'userId', content: 'content',
  },
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
  // These are pure-telemetry call sites: they hand the tracking promise to a NAMED
  // discard rather than leaving it to float, so the mocked module has to provide it.
  discardUsageOutcome: (tracking: Promise<unknown>) => {
    void Promise.resolve(tracking).then(
      () => undefined,
      () => undefined,
    );
  },
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
  // The page-chat query selects sql`${conversations.contextId}`: resolve it to that column.
  return { ...fixtureOperators, sql: (_strings: TemplateStringsArray, column: unknown) => column };
});

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', timezone: 'timezone', name: 'name', email: 'email', subscriptionTier: 'subscriptionTier', accountType: 'accountType' },
}));
vi.mock('@pagespace/db/schema/sessions', () => ({
  sessions: { userId: 'userId', type: 'type', revokedAt: 'revokedAt', lastUsedAt: 'lastUsedAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed', title: 'title', content: 'content' },
  drives: { id: 'id', name: 'name', drivePrompt: 'drivePrompt', isTrashed: 'isTrashed', ownerId: 'ownerId' },
  userMentions: { targetUserId: 'targetUserId', createdAt: 'createdAt', mentionedByUserId: 'mentionedByUserId', sourcePageId: 'sourcePageId' },
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
import { generateText } from 'ai';
import { groupActivitiesForDiff } from '@pagespace/lib/content/activity-diff-utils';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { drives, userMentions } from '@pagespace/db/schema/core';
import { messages } from '@pagespace/db/schema/conversations';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';

const USER_ID = 'user-1';
const PAGE_ID = 'page-1';
const AGENT = '[AI agent account, self-named] "Helper"';

type Person = { id: string; name: string; accountType: 'human' | 'agent' };
const helper: Person = { id: 'agent-1', name: 'Helper', accountType: 'agent' };
const jane: Person = { id: 'user-2', name: '  Jane Doe ', accountType: 'human' };

function setupTables(people: Person[]) {
  const now = new Date();
  const joined = (p: Person) => ({ name: p.name, email: `${p.id}@example.com`, accountType: p.accountType });
  h.tableRows.clear();
  h.accessiblePageIds = [PAGE_ID];
  h.tableRows.set(users, [{ id: USER_ID, timezone: 'UTC', name: 'Tester', email: 'tester@example.com', subscriptionTier: 'pro' }]);
  h.tableRows.set(sessions, [{ userId: USER_ID, type: 'user', revokedAt: null, lastUsedAt: now }]);
  h.tableRows.set(drives, [{ id: 'drive-1', name: 'Drive', drivePrompt: null, isTrashed: false }]);
  h.tableRows.set(driveMembers, people.map((p) => ({ driveId: 'drive-1', userId: p.id, acceptedAt: now, ...joined(p) })));
  h.tableRows.set(activityLogs, people.map((p, i) => ({
    id: `act-${i}`, userId: p.id, actorDisplayName: p.name, actorEmail: `${p.id}@example.com`,
    operation: 'update', resourceType: 'page', resourceId: PAGE_ID, pageId: PAGE_ID, resourceTitle: 'Plan',
    driveId: 'drive-1', timestamp: now, changeGroupId: null, aiConversationId: null, isAiGenerated: false,
    contentRef: null, contentSnapshot: 'before', ...joined(p),
  })));
  h.tableRows.set(dmConversations, people.map((p) => ({ id: `conv-${p.id}`, participant1Id: USER_ID, participant2Id: p.id })));
  h.tableRows.set(directMessages, people.map((p) => ({
    conversationId: `conv-${p.id}`, senderId: p.id, isRead: false, isActive: true, parentId: null,
    content: 'hello', createdAt: now, ...joined(p),
  })));
  h.tableRows.set(messages, people.map((p, i) => ({
    msgId: `m-${i}`, conversationId: `c-${i}`, contextId: PAGE_ID, convType: 'page', title: 'Plan', driveId: 'drive-1',
    role: 'user', isActive: true, createdAt: now, userId: p.id, content: 'question', ...joined(p),
  })));
  h.tableRows.set(userMentions, people.map((p) => ({
    targetUserId: USER_ID, createdAt: now, mentionedByUserId: p.id, sourcePageId: PAGE_ID, title: 'Plan', ...joined(p),
  })));
  h.tableRows.set(pagePermissions, people.map((p) => ({
    userId: USER_ID, pageId: PAGE_ID, grantedBy: p.id, grantedAt: now, title: 'Plan', content: '', ...joined(p),
  })));
}

const makeRequest = () => new Request('https://example.com/api/pulse/cron', { method: 'POST' });

type PromptContext = {
  workspace: { drives: { teamMembers: string[] }[] };
  activitySummary: { person: string }[];
  directMessages: { from: string }[];
  pageDiscussions: { messages: { from: string }[] }[];
  mentions: { by: string }[];
  sharedWithYou: { by: string }[];
};

async function promptContext(): Promise<PromptContext> {
  const response = await POST(makeRequest());
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  expect(body.generated).toBe(1);
  const call = vi.mocked(generateText).mock.calls[0][0] as unknown as { messages: { content: string }[] };
  const prompt = call.messages[0].content;
  const json = prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1);
  return JSON.parse(json) as PromptContext;
}

describe('POST /api/pulse/cron — agent names in the prompt are labelled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.insertValuesMock.mockResolvedValue(undefined);
  });

  it('labels an agent in every name slot: team, activity, DMs, page chats, mentions, shares', async () => {
    setupTables([helper]);
    const ctx = await promptContext();
    expect(ctx.workspace.drives[0].teamMembers).toEqual([AGENT]);
    expect(ctx.activitySummary.map((a) => a.person)).toEqual([AGENT]);
    expect(ctx.directMessages.map((m) => m.from)).toEqual([AGENT]);
    expect(ctx.pageDiscussions[0].messages.map((m) => m.from)).toEqual([AGENT]);
    expect(ctx.mentions.map((m) => m.by)).toEqual([AGENT]);
    expect(ctx.sharedWithYou.map((s) => s.by)).toEqual([AGENT]);
  });

  it('labels an agent in the content-diff actor identity', async () => {
    setupTables([helper]);
    await promptContext();
    expect(vi.mocked(groupActivitiesForDiff).mock.calls[0][0][0].actorDisplayName).toBe(AGENT);
  });

  it('passes a human name through byte-identical in every slot', async () => {
    setupTables([jane]);
    const ctx = await promptContext();
    expect(ctx.workspace.drives[0].teamMembers).toEqual([jane.name]);
    expect(ctx.activitySummary.map((a) => a.person)).toEqual([jane.name]);
    expect(ctx.directMessages.map((m) => m.from)).toEqual([jane.name]);
    expect(ctx.pageDiscussions[0].messages.map((m) => m.from)).toEqual([jane.name]);
    expect(ctx.mentions.map((m) => m.by)).toEqual([jane.name]);
    expect(ctx.sharedWithYou.map((s) => s.by)).toEqual([jane.name]);
    expect(vi.mocked(groupActivitiesForDiff).mock.calls[0][0][0].actorDisplayName).toBe(jane.name);
  });
});
