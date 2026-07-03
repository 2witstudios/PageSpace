import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * pageService.createPage() — TASK_LIST seeding coverage.
 *
 * Mocks every dependency at its architectural boundary so the transaction body
 * actually runs, letting these tests assert on the exact `ensureTaskListForPage`
 * call `createPage()` makes for a TASK_LIST page — the fix that guarantees the
 * browser page-creation flow seeds `taskStatusConfigs` immediately instead of
 * relying on lazy self-heal on first UI load.
 */

const mockFindFirstDrive = vi.fn();
const mockFindFirstPage = vi.fn();
const mockTxInsertReturning = vi.fn();
const mockEnsureTaskItemForPage = vi.fn();
const mockEnsureTaskListForPage = vi.fn();
const mockCreatePageVersion = vi.fn();
const mockLogActivityWithTx = vi.fn();

vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  DEFAULT_PROVIDER: 'anthropic',
  DEFAULT_MODEL: 'test-model',
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: (...args: unknown[]) => mockFindFirstDrive(...args) },
      pages: { findFirst: (...args: unknown[]) => mockFindFirstPage(...args) },
      users: { findFirst: vi.fn() },
    },
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({
      insert: () => ({
        values: () => ({
          returning: (...args: unknown[]) => mockTxInsertReturning(...args),
        }),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {}, drives: {}, chatMessages: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ driveAgentMembers: {} }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn().mockResolvedValue(true),
  canUserDeletePage: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logActivityWithTx: (...args: unknown[]) => mockLogActivityWithTx(...args),
}));
vi.mock('@pagespace/lib/content/page-content-format', () => ({
  detectPageContentFormat: vi.fn(() => 'text'),
}));
vi.mock('@pagespace/lib/utils/hash-utils', () => ({
  hashWithPrefix: vi.fn(() => 'content-ref'),
}));
vi.mock('@pagespace/lib/services/page-version-service', () => ({
  computePageStateHash: vi.fn(() => 'state-hash'),
  createPageVersion: (...args: unknown[]) => mockCreatePageVersion(...args),
}));
vi.mock('@pagespace/lib/pages/circular-reference-guard', () => ({
  validatePageMove: vi.fn(),
}));
vi.mock('@pagespace/lib/content/page-type-validators', () => ({
  validatePageCreation: vi.fn(() => ({ valid: true, errors: [] })),
  validateAIChatTools: vi.fn(() => ({ valid: true, errors: [] })),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
  getDefaultContent: vi.fn(() => ''),
  isAIChatPage: vi.fn((type: string) => type === 'AI_CHAT'),
}));
vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { TASK_LIST: 'TASK_LIST', DOCUMENT: 'DOCUMENT', AI_CHAT: 'AI_CHAT' },
}));
vi.mock('@pagespace/lib/monitoring/change-group', () => ({
  createChangeGroupId: vi.fn(() => 'change-group-1'),
  inferChangeGroupType: vi.fn(() => 'user'),
}));
vi.mock('../page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class PageRevisionMismatchError extends Error {},
}));
vi.mock('../task-sync-service', () => ({
  ensureTaskItemForPage: (...args: unknown[]) => mockEnsureTaskItemForPage(...args),
  ensureTaskListForPage: (...args: unknown[]) => mockEnsureTaskListForPage(...args),
}));

import { pageService } from '../page-service';

describe('pageService.createPage — TASK_LIST seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstDrive.mockResolvedValue({ id: 'drive-1', ownerId: 'owner-1' });
    mockFindFirstPage.mockResolvedValue(undefined); // no sibling pages -> position 1
    mockEnsureTaskItemForPage.mockResolvedValue(undefined);
    mockEnsureTaskListForPage.mockResolvedValue({ id: 'tasklist-1' });
    mockCreatePageVersion.mockResolvedValue(undefined);
    mockLogActivityWithTx.mockResolvedValue(undefined);
  });

  it('seeds task_lists + default task_status_configs for a root TASK_LIST page (no TASK_LIST parent)', async () => {
    mockTxInsertReturning.mockResolvedValue([{
      id: 'new-tasklist-page',
      title: 'My Tasks',
      type: 'TASK_LIST',
      parentId: null,
      driveId: 'drive-1',
      content: '',
      contentMode: 'html',
      position: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      revision: 0,
      stateHash: 'state-hash',
      isTrashed: false,
      trashedAt: null,
      aiProvider: null,
      aiModel: null,
      systemPrompt: null,
      enabledTools: null,
      isPaginated: null,
    }]);

    const result = await pageService.createPage('user-123', {
      title: 'My Tasks',
      type: 'TASK_LIST',
      driveId: 'drive-1',
    });

    expect(result.success).toBe(true);
    // This is the crux of the fix: a bare top-level TASK_LIST page (parentId
    // null, so ensureTaskItemForPage's TASK_LIST-under-TASK_LIST check never
    // fires) must still get its own task_lists/task_status_configs seeded here,
    // immediately, rather than relying on lazy self-heal on first UI load.
    expect(mockEnsureTaskListForPage).toHaveBeenCalledWith(
      expect.anything(),
      { pageId: 'new-tasklist-page', title: 'My Tasks', userId: 'user-123' }
    );
  });

  it('does not seed task_lists for non-TASK_LIST page types', async () => {
    mockTxInsertReturning.mockResolvedValue([{
      id: 'new-doc-page',
      title: 'My Doc',
      type: 'DOCUMENT',
      parentId: null,
      driveId: 'drive-1',
      content: '',
      contentMode: 'html',
      position: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      revision: 0,
      stateHash: 'state-hash',
      isTrashed: false,
      trashedAt: null,
      aiProvider: null,
      aiModel: null,
      systemPrompt: null,
      enabledTools: null,
      isPaginated: null,
    }]);

    const result = await pageService.createPage('user-123', {
      title: 'My Doc',
      type: 'DOCUMENT',
      driveId: 'drive-1',
    });

    expect(result.success).toBe(true);
    expect(mockEnsureTaskListForPage).not.toHaveBeenCalled();
  });
});
