import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// POST /api/pulse/generate — the "overdue"/"due today" task lists fed to the AI
// narrative (and persisted in contextData) must exclude tasks whose page isn't
// in the user's accessible-pages set (trashed page, page in a trashed drive,
// drive membership revoked), while still including tasks on pages the user can
// reach via owner access (even with no accepted drive_members row yet) or an
// explicit page-level permission grant with no drive membership at all.
//
// The fix reuses this route's existing `accessiblePageIds(userId)` call (the
// same canonical, already-tested access-control primitive used elsewhere in
// this file for content/activity scoping) to filter tasks via
// `inArray(taskItems.pageId, accessiblePagesList)`, rather than a hand-rolled
// driveId filter — so these tests model "is this page accessible" directly via
// the mocked `accessiblePageIds` return value instead of re-deriving
// trash/membership/ownership logic that's that function's own responsibility.
//
// Uses the same fixture-based fake DB as ../../__tests__/route.test.ts so the
// where-condition is genuinely evaluated against fixture rows, not just
// inspected structurally.
// ============================================================================

const h = vi.hoisted(() => ({
  tableRows: new Map<unknown, Record<string, unknown>[]>(),
  accessiblePageIds: [] as string[],
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() } },
}));

vi.mock('@pagespace/lib/billing/automation-preferences', () => ({
  resolvePulseEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn(() => ''),
  getUserTimeOfDay: vi.fn(() => ({ timeOfDay: 'morning' })),
  getStartOfTodayInTimezone: vi.fn(() => new Date('2024-01-10T00:00:00.000Z')),
  isValidTimezone: vi.fn(() => true),
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
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({ MAX_CHAT_INFLIGHT: 3 }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/subscription/credit-gate-response', () => ({
  creditGateErrorResponse: vi.fn(() => new Response(JSON.stringify({ error: 'blocked' }), { status: 402 })),
}));

vi.mock('@pagespace/db/db', async () => {
  const { createFixtureSelect } = await import('../../__tests__/task-fixture-db');
  return {
    db: {
      select: createFixtureSelect(h.tableRows),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      insert: vi.fn(() => ({
        values: (row: Record<string, unknown>) => {
          const result = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<Record<string, unknown>[]> };
          result.returning = () => Promise.resolve([{
            id: 'summary-1',
            generatedAt: new Date('2024-01-10T00:00:00.000Z'),
            expiresAt: new Date('2024-01-10T06:00:00.000Z'),
            ...row,
          }]);
          return result;
        },
      })),
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
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed', title: 'title' },
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
  directMessages: { conversationId: 'conversationId', senderId: 'senderId', isRead: 'isRead', isActive: 'isActive', parentId: 'parentId' },
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
import { taskItems } from '@pagespace/db/schema/tasks';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const USER_ID = 'user-1';
const PAGE_ID = 'page-1';

const mockAuth = () => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session' as const,
  sessionId: 'sess-1',
  role: 'user' as const,
  adminRoleVersion: 0,
});

const overdueTaskRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  assigneeId: USER_ID,
  userId: USER_ID,
  status: 'pending',
  dueDate: new Date('2024-01-05T00:00:00.000Z'),
  completedAt: null,
  priority: 'high',
  title: 'Ship the report',
  pageId: PAGE_ID,
  ...overrides,
});

function setupTables(taskRows: Record<string, unknown>[], accessiblePageIds: string[]) {
  h.tableRows.clear();
  h.accessiblePageIds = accessiblePageIds;
  h.tableRows.set(users, [{ id: USER_ID, timezone: 'UTC', name: 'Tester', email: 'tester@example.com', subscriptionTier: 'pro' }]);
  h.tableRows.set(taskItems, taskRows);
}

const makeRequest = () =>
  new Request('https://example.com/api/pulse/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

describe('POST /api/pulse/generate — task lists scoped to accessible pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  it('excludes an overdue task whose page is not accessible (trashed, or drive access revoked) from the narrative context', async () => {
    setupTables([overdueTaskRow()], [] /* PAGE_ID not accessible */);

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.contextData.tasks.overdue).toBe(0);
    expect(body.contextData.tasks.overdueItems).toEqual([]);
  });

  it('includes a normal overdue task whose page is accessible', async () => {
    setupTables([overdueTaskRow()], [PAGE_ID]);

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.contextData.tasks.overdue).toBe(1);
    expect(body.contextData.tasks.overdueItems).toEqual([{ title: 'Ship the report', priority: 'high' }]);
  });

  it('resolves task lists to empty when the user has no accessible pages at all', async () => {
    setupTables([overdueTaskRow()], []); // would appear if the filter were missing

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.contextData.tasks.overdue).toBe(0);
    expect(body.contextData.tasks.overdueItems).toEqual([]);
  });

  it('includes an overdue task in a drive the user owns but has no accepted membership row for yet', async () => {
    // Owner drive_members rows are only lazily backfilled on first access
    // (updateDriveLastAccessed). accessiblePageIds grants owner access
    // independent of that row, so the page is accessible regardless.
    setupTables([overdueTaskRow()], [PAGE_ID]);

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.contextData.tasks.overdue).toBe(1);
    expect(body.contextData.tasks.overdueItems).toEqual([{ title: 'Ship the report', priority: 'high' }]);
  });

  it('includes an overdue task on a page shared via explicit permission with no drive membership', async () => {
    // A user can be assigned a task on a page shared directly with them
    // (page_permissions.canView) without ever being a drive member.
    // accessiblePageIds includes this; a driveId-based filter could not,
    // since there is no drive membership row at all.
    setupTables([overdueTaskRow()], [PAGE_ID]);

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(body.contextData.tasks.overdue).toBe(1);
    expect(body.contextData.tasks.overdueItems).toEqual([{ title: 'Ship the report', priority: 'high' }]);
  });
});
