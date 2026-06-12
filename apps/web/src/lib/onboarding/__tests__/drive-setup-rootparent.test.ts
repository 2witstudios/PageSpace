import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { insert: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {},
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: {},
  taskLists: {},
}));
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated-id'),
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  DEFAULT_PROVIDER: 'anthropic',
  DEFAULT_MODEL: 'claude-3-5-sonnet',
}));
vi.mock('../onboarding-faq', () => ({
  getAboutPageSpaceAgentSystemPrompt: vi.fn().mockReturnValue('system-prompt'),
  getReferenceSeedTemplate: vi.fn().mockReturnValue({
    title: 'Reference',
    type: 'FOLDER',
    content: '',
    children: [],
  }),
}));
vi.mock('../faq/content-page-types', () => ({
  buildBudgetSheetContent: vi.fn().mockReturnValue(''),
}));
vi.mock('../faq/example-agent-prompts', () => ({
  PLANNING_ASSISTANT_SYSTEM_PROMPT: 'planning-prompt',
}));

import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { populateUserDrive } from '../drive-setup';

describe('populateUserDrive – rootParentId option', () => {
  let insertCalls: unknown[];

  beforeEach(() => {
    insertCalls = [];
    vi.mocked(db.insert).mockImplementation((_table: unknown) => {
      const values = vi.fn().mockImplementation((data: unknown) => {
        insertCalls.push({ table: _table, data });
        return Promise.resolve();
      });
      return { values } as unknown as ReturnType<typeof db.insert>;
    });
  });

  test('without options, top-level inserts have no parentId', async () => {
    await populateUserDrive('user-1', 'drive-1');

    const pageInserts = insertCalls.filter((c: unknown) => (c as { table: unknown }).table === pages);
    const firstPage = pageInserts[0] as { data: { parentId?: string } };
    expect(firstPage.data.parentId).toBeUndefined();
  });

  test('with rootParentId option, top-level inserts use it as parentId', async () => {
    await populateUserDrive('user-1', 'drive-1', db, { rootParentId: 'folder-root' });

    const pageInserts = insertCalls.filter((c: unknown) => (c as { table: unknown }).table === pages);
    const firstPage = pageInserts[0] as { data: { parentId?: string } };
    expect(firstPage.data.parentId).toBe('folder-root');
  });

  test('with rootParentId option, task-list child pages still use their own explicit parentId', async () => {
    await populateUserDrive('user-1', 'drive-1', db, { rootParentId: 'folder-root' });

    const pageInserts = insertCalls.filter((c: unknown) => (c as { table: unknown }).table === pages);
    // task pages have a parentId that is not 'folder-root' (they use the taskListPageId)
    const taskChildPages = pageInserts.filter(
      (c: unknown) =>
        (c as { data: { parentId?: string; type?: string } }).data.type === 'TASK_LIST' &&
        (c as { data: { parentId?: string } }).data.parentId !== 'folder-root' &&
        (c as { data: { parentId?: string } }).data.parentId !== undefined
    );
    // task items are children of the task list page
    expect(taskChildPages.length).toBeGreaterThan(0);
  });
});
