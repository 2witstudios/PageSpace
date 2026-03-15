import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @pagespace/db
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  pages: {},
  taskLists: {},
  taskItems: {},
}));

// Mock @paralleldrive/cuid2
let idCounter = 0;
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => `mock-id-${++idCounter}`),
}));

// Mock onboarding-faq
vi.mock('../onboarding-faq', () => ({
  getAboutPageSpaceAgentSystemPrompt: vi.fn(() => 'mock-system-prompt'),
  getReferenceSeedTemplate: vi.fn(() => ({
    title: 'Reference',
    type: 'FOLDER',
    children: [
      {
        title: 'Page Types Overview',
        type: 'DOCUMENT',
        content: 'mock overview content',
      },
    ],
  })),
}));

// Mock content-page-types (faq/content-page-types)
vi.mock('../faq/content-page-types', () => ({
  buildBudgetSheetContent: vi.fn(() => '{"cells":{"A1":"Item"}}'),
}));

// Mock example-agent-prompts
vi.mock('../faq/example-agent-prompts', () => ({
  PLANNING_ASSISTANT_SYSTEM_PROMPT: 'mock-planning-prompt',
}));

import { db, pages, taskLists, taskItems } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { populateUserDrive } from '../drive-setup';

describe('populateUserDrive', () => {
  let mockInsertValues: ReturnType<typeof vi.fn>;
  let mockInsert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;

    // Set up chainable insert mock: client.insert(table).values(data)
    mockInsertValues = vi.fn().mockResolvedValue(undefined);
    mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
    vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);
  });

  it('uses the default db client when none is provided', async () => {
    await populateUserDrive('user-1', 'drive-1');
    expect(db.insert).toHaveBeenCalled();
  });

  it('accepts a custom db client', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('inserts the Welcome to PageSpace document page', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Welcome to PageSpace';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Welcome to PageSpace',
      type: 'DOCUMENT',
      driveId: 'drive-1',
      position: 1,
    });
  });

  it('inserts the Example Notes document page', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Example Notes';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Example Notes',
      type: 'DOCUMENT',
      driveId: 'drive-1',
      position: 2,
    });
  });

  it('inserts the Budget Tracker sheet page', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Budget Tracker';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Budget Tracker',
      type: 'SHEET',
      driveId: 'drive-1',
      position: 3,
    });
  });

  it('inserts the Getting Started Tasks page of type TASK_LIST', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Getting Started Tasks';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Getting Started Tasks',
      type: 'TASK_LIST',
      driveId: 'drive-1',
      position: 4,
    });
  });

  it('inserts a task list record for Getting Started Tasks', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    // taskLists.values should be called once
    const taskListInsertCalls = mockInsert.mock.calls.filter(
      (call) => call[0] === taskLists
    );
    expect(taskListInsertCalls.length).toBe(1);

    const taskListInsertValuesCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Getting Started';
    });
    expect(taskListInsertValuesCalls.length).toBe(1);
    expect(taskListInsertValuesCalls[0][0]).toMatchObject({
      title: 'Getting Started',
      userId: 'user-1',
      status: 'in_progress',
    });
  });

  it('inserts task item pages for each task in Getting Started Tasks', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const taskItemInsertCalls = mockInsert.mock.calls.filter(
      (call) => call[0] === taskItems
    );
    // There are 4 tasks in the Getting Started task list
    expect(taskItemInsertCalls.length).toBe(4);
  });

  it('assigns task items to the user when assignee is self', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const taskItemValuesCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.assigneeId !== undefined;
    });

    // All 4 tasks have assignee: 'self', so assigneeId should be 'user-1'
    const selfAssigned = taskItemValuesCalls.filter((call) => call[0].assigneeId === 'user-1');
    expect(selfAssigned.length).toBe(4);
  });

  it('inserts the Upload Files Here folder page', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Upload Files Here';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Upload Files Here',
      type: 'FOLDER',
      driveId: 'drive-1',
      position: 5,
    });
  });

  it('inserts the My Dashboard canvas page', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'My Dashboard';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'My Dashboard',
      type: 'CANVAS',
      driveId: 'drive-1',
      position: 6,
    });
  });

  it('inserts the General Chat channel page', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'General Chat';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'General Chat',
      type: 'CHANNEL',
      driveId: 'drive-1',
      position: 7,
    });
  });

  it('inserts the PageSpace Guide AI chat page with system prompt', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'PageSpace Guide';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'PageSpace Guide',
      type: 'AI_CHAT',
      systemPrompt: 'mock-system-prompt',
      driveId: 'drive-1',
      position: 8,
    });
  });

  it('inserts the Planning Assistant AI chat page with planning system prompt', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Planning Assistant';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Planning Assistant',
      type: 'AI_CHAT',
      systemPrompt: 'mock-planning-prompt',
      driveId: 'drive-1',
      position: 9,
    });
  });

  it('inserts the Reference folder from seed template at position 10', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Reference';
    });
    expect(pageCalls.length).toBe(1);
    expect(pageCalls[0][0]).toMatchObject({
      title: 'Reference',
      type: 'FOLDER',
      driveId: 'drive-1',
      position: 10,
    });
  });

  it('sets isTrashed to false on all pages', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const pageInsertCalls = mockInsert.mock.calls.filter((call) => call[0] === pages);
    const valuesWithTrashed = pageInsertCalls.map(
      (_, i) => mockInsertValues.mock.calls[i]?.[0]
    );

    const allPageValues = mockInsertValues.mock.calls
      .map((call) => call[0])
      .filter((val) => val && val.isTrashed !== undefined);

    allPageValues.forEach((val) => {
      expect(val.isTrashed).toBe(false);
    });
  });

  it('calls createId to generate unique ids for pages', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);
    expect(createId).toHaveBeenCalled();
  });

  it('calculates due dates correctly for tasks with dueInDays', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    const taskItemValuesCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.taskListId !== undefined;
    });

    // Task with dueInDays: 0 should have dueDate equal to now (same day)
    const taskWithDue0 = taskItemValuesCalls.find(
      (call) => call[0].title === 'Open and edit Example Notes'
    );
    expect(taskWithDue0).toBeDefined();
    expect(taskWithDue0![0].dueDate).toBeInstanceOf(Date);

    // Task with dueInDays: 2 should have dueDate 2 days in the future
    const taskWithDue2 = taskItemValuesCalls.find(
      (call) => call[0].title === 'Create your first project folder'
    );
    expect(taskWithDue2).toBeDefined();
    expect(taskWithDue2![0].dueDate).toBeInstanceOf(Date);
  });

  it('inserts children of the Reference folder', async () => {
    const customClient = { insert: mockInsert };
    await populateUserDrive('user-1', 'drive-1', customClient as never);

    // The mock reference template has one child: 'Page Types Overview'
    const childPageCalls = mockInsertValues.mock.calls.filter((call) => {
      const val = call[0];
      return val && val.title === 'Page Types Overview';
    });
    expect(childPageCalls.length).toBe(1);
  });
});
