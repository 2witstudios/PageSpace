import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  parseArgv,
  tasksAssignedHandler,
  tasksCreateHandler,
  tasksCreateStatusHandler,
  tasksDeleteHandler,
  tasksListHandler,
  tasksReorderHandler,
  tasksStatusesHandler,
  tasksUpdateHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const USER_REF = { id: 'user_1', name: 'Ada', image: null };

const TASK = {
  id: 'task_1',
  userId: 'user_1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: 'pg_list_1',
  status: 'in_progress',
  priority: 'medium' as const,
  position: 0,
  dueDate: null,
  metadata: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assignee: null,
  assigneeAgent: null,
  user: USER_REF,
  page: { id: 'pg_task_1', title: 'RED — write tests' },
  assignees: [],
  title: 'RED — write tests',
};

const TASK_LIST_ITEM = {
  id: 'task_1',
  title: 'RED — write tests',
  status: 'in_progress',
  priority: 'medium' as const,
  assigneeId: null,
  assigneeAgentId: null,
  dueDate: null,
  position: 0,
  completedAt: null,
  pageId: 'pg_task_1',
  assignee: null,
  assigneeAgent: null,
  assignees: [],
  hasContent: false,
  subTaskCount: 0,
  subTaskCompletedCount: 0,
};

const TASK_LIST_READ_RESULT = {
  pageId: 'pg_list_1',
  pageTitle: 'Sprint Board',
  pageType: 'TASK_LIST' as const,
  taskListId: 'tl_1',
  parentTaskList: null,
  totalLines: 1,
  numberedLines: ['   1 | # Sprint Board'],
  content: '# Sprint Board',
  tasks: [TASK_LIST_ITEM],
  availableStatuses: [
    { slug: 'pending', label: 'To Do', group: 'todo', position: 0, color: null },
    { slug: 'in_progress', label: 'In Progress', group: 'in_progress', position: 1, color: null },
    { slug: 'completed', label: 'Done', group: 'done', position: 2, color: null },
  ],
  progress: { total: 1, percentage: 0, byGroup: { todo: 0, in_progress: 1, done: 0 }, bySlug: { in_progress: 1 } },
};

const GENERIC_READ_RESULT = {
  pageId: 'pg_doc_1',
  pageTitle: 'Not a task list',
  totalLines: 1,
  numberedLines: ['   1 | hello'],
  content: 'hello',
};

const ASSIGNED_RESULT = {
  tasks: [
    {
      ...TASK,
      driveId: 'drv_1',
      taskListPageId: 'pg_list_1',
      taskListPageTitle: 'Sprint Board',
      statusGroup: 'in_progress' as const,
      statusLabel: 'In Progress',
      statusColor: '#00f',
      page: { id: 'pg_task_1', title: 'RED — write tests', isTrashed: false, parentId: 'pg_list_1' },
    },
  ],
  statusConfigsByTaskList: {},
  pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
};

describe('tasksListHandler', () => {
  it('exits 2 with a usage error when pageId is missing', async () => {
    const read = vi.fn(async () => TASK_LIST_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await tasksListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  it('calls pages.read with the given pageId', async () => {
    const read = vi.fn(async () => TASK_LIST_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await tasksListHandler(ctx, commandIntent(['pg_list_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(read).toHaveBeenCalledWith({ operation: 'read', pageId: 'pg_list_1' });
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => TASK_LIST_READ_RESULT } }) });

    await tasksListHandler(ctx, commandIntent(['pg_list_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(TASK_LIST_READ_RESULT);
  });

  it('renders task ids, statuses, and progress in human mode', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => TASK_LIST_READ_RESULT } }) });

    await tasksListHandler(ctx, commandIntent(['pg_list_1']));

    const output = stdout.lines.join('');
    expect(output).toContain('task_1');
    expect(output).toContain('in_progress');
    expect(output).toMatch(/progress/i);
  });

  it('errors when the page is not a TASK_LIST, without touching stdout', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ pages: { read: async () => GENERIC_READ_RESULT } }) });

    const code = await tasksListHandler(ctx, commandIntent(['pg_doc_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/not a task list/i);
  });
});

describe('tasksStatusesHandler', () => {
  it('exits 2 with a usage error when pageId is missing', async () => {
    const read = vi.fn(async () => TASK_LIST_READ_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { read } }) });

    const code = await tasksStatusesHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => TASK_LIST_READ_RESULT } }) });

    await tasksStatusesHandler(ctx, commandIntent(['pg_list_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(TASK_LIST_READ_RESULT);
  });

  it('renders every available status slug and group in human mode', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { read: async () => TASK_LIST_READ_RESULT } }) });

    await tasksStatusesHandler(ctx, commandIntent(['pg_list_1']));

    const output = stdout.lines.join('');
    expect(output).toContain('pending');
    expect(output).toContain('in_progress');
    expect(output).toContain('completed');
  });

  it('errors when the page is not a TASK_LIST', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ pages: { read: async () => GENERIC_READ_RESULT } }) });

    const code = await tasksStatusesHandler(ctx, commandIntent(['pg_doc_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/not a task list/i);
  });
});

describe('tasksCreateHandler', () => {
  it('requires pageId and --title', async () => {
    const create = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { create } }) });

    const code = await tasksCreateHandler(ctx, commandIntent(['pg_list_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });

  it('calls tasks.create with only the flags given', async () => {
    const create = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { create } }) });

    const code = await tasksCreateHandler(ctx, commandIntent(['pg_list_1', '--title', 'Ship it']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(create).toHaveBeenCalledWith({
      pageId: 'pg_list_1',
      title: 'Ship it',
      priority: undefined,
      status: undefined,
      dueDate: undefined,
      assigneeId: undefined,
    });
  });

  it('maps every optional flag through to the SDK call', async () => {
    const create = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { create } }) });

    await tasksCreateHandler(
      ctx,
      commandIntent([
        'pg_list_1',
        '--title',
        'Ship it',
        '--priority',
        'high',
        '--status',
        'in_progress',
        '--due',
        '2026-02-01',
        '--assignee',
        'user_2',
      ]),
    );

    expect(create).toHaveBeenCalledWith({
      pageId: 'pg_list_1',
      title: 'Ship it',
      priority: 'high',
      status: 'in_progress',
      dueDate: '2026-02-01',
      assigneeId: 'user_2',
    });
  });

  it('rejects an invalid --priority as a usage error without calling the SDK', async () => {
    const create = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { create } }) });

    const code = await tasksCreateHandler(ctx, commandIntent(['pg_list_1', '--title', 'Ship it', '--priority', 'urgent']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(create).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ tasks: { create: async () => TASK } }) });

    await tasksCreateHandler(ctx, commandIntent(['pg_list_1', '--title', 'Ship it', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(TASK);
  });
});

describe('tasksUpdateHandler', () => {
  it('requires pageId and taskId', async () => {
    const update = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { update } }) });

    const code = await tasksUpdateHandler(ctx, commandIntent(['pg_list_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(update).not.toHaveBeenCalled();
  });

  it('maps every update flag combo through to the SDK call', async () => {
    const update = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { update } }) });

    await tasksUpdateHandler(
      ctx,
      commandIntent(['pg_list_1', 'task_1', '--status', 'completed', '--title', 'Renamed', '--priority', 'low', '--due', '2026-03-01']),
    );

    expect(update).toHaveBeenCalledWith({
      pageId: 'pg_list_1',
      taskId: 'task_1',
      title: 'Renamed',
      status: 'completed',
      priority: 'low',
      dueDate: '2026-03-01',
    });
  });

  it('passes undefined for flags not given', async () => {
    const update = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { update } }) });

    await tasksUpdateHandler(ctx, commandIntent(['pg_list_1', 'task_1', '--status', 'completed']));

    expect(update).toHaveBeenCalledWith({
      pageId: 'pg_list_1',
      taskId: 'task_1',
      title: undefined,
      status: 'completed',
      priority: undefined,
      dueDate: undefined,
    });
  });

  it('rejects an invalid --priority as a usage error without calling the SDK', async () => {
    const update = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { update } }) });

    const code = await tasksUpdateHandler(ctx, commandIntent(['pg_list_1', 'task_1', '--priority', 'urgent']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(update).not.toHaveBeenCalled();
  });

  it('renders the server container-gating rejection message verbatim, exit 1', async () => {
    const gateMessage = 'Cannot complete task: sub-tasks incomplete (2 of 5 remaining)';
    const update = vi.fn(async () => {
      throw new Error(gateMessage);
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ tasks: { update } }) });

    const code = await tasksUpdateHandler(ctx, commandIntent(['pg_list_1', 'task_1', '--status', 'completed']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain(gateMessage);
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ tasks: { update: async () => TASK } }) });

    await tasksUpdateHandler(ctx, commandIntent(['pg_list_1', 'task_1', '--status', 'completed', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(TASK);
  });
});

describe('tasksDeleteHandler (destructive)', () => {
  it('with --yes in a non-TTY session: deletes without prompting', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'irrelevant');
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { delete: del } }), isTTY: false, prompt });

    const code = await tasksDeleteHandler(ctx, commandIntent(['pg_list_1', 'task_1', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ pageId: 'pg_list_1', taskId: 'task_1' });
  });

  it('fails closed in a non-TTY session without --yes, never calling delete', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { delete: del } }), isTTY: false, stderr });

    const code = await tasksDeleteHandler(ctx, commandIntent(['pg_list_1', 'task_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(del).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toMatch(/--yes/);
  });

  it('in a TTY session without --yes, prompts and deletes on an affirmative answer', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'y');
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { delete: del } }), isTTY: true, prompt });

    const code = await tasksDeleteHandler(ctx, commandIntent(['pg_list_1', 'task_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(prompt).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ pageId: 'pg_list_1', taskId: 'task_1' });
  });

  it('in a TTY session without --yes, refuses on a declined answer', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const prompt = vi.fn(async () => 'n');
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { delete: del } }), isTTY: true, prompt });

    const code = await tasksDeleteHandler(ctx, commandIntent(['pg_list_1', 'task_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(del).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when taskId is missing', async () => {
    const del = vi.fn(async () => ({ success: true }));
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { delete: del } }) });

    const code = await tasksDeleteHandler(ctx, commandIntent(['pg_list_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('tasksReorderHandler', () => {
  it('calls tasks.reorder with pageId, taskId, and a numeric position', async () => {
    const reorder = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { reorder } }) });

    const code = await tasksReorderHandler(ctx, commandIntent(['pg_list_1', 'task_1', '2']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(reorder).toHaveBeenCalledWith({ pageId: 'pg_list_1', taskId: 'task_1', position: 2 });
  });

  it('exits 2 with a usage error for a non-numeric position, never calling the SDK', async () => {
    const reorder = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { reorder } }) });

    const code = await tasksReorderHandler(ctx, commandIntent(['pg_list_1', 'task_1', 'not-a-number']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when position is missing', async () => {
    const reorder = vi.fn(async () => TASK);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { reorder } }) });

    const code = await tasksReorderHandler(ctx, commandIntent(['pg_list_1', 'task_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(reorder).not.toHaveBeenCalled();
  });
});

describe('tasksCreateStatusHandler', () => {
  const STATUS_CONFIG = {
    id: 'status_1',
    taskListId: 'tl_1',
    name: 'Blocked',
    slug: 'blocked',
    color: '#f00',
    group: 'in_progress' as const,
    position: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('requires --name, --color, and --group', async () => {
    const createStatus = vi.fn(async () => STATUS_CONFIG);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { createStatus } }) });

    const code = await tasksCreateStatusHandler(ctx, commandIntent(['pg_list_1', '--name', 'Blocked']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(createStatus).not.toHaveBeenCalled();
  });

  it('rejects an invalid --group as a usage error without calling the SDK', async () => {
    const createStatus = vi.fn(async () => STATUS_CONFIG);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { createStatus } }) });

    const code = await tasksCreateStatusHandler(
      ctx,
      commandIntent(['pg_list_1', '--name', 'Blocked', '--color', '#f00', '--group', 'not-a-group']),
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(createStatus).not.toHaveBeenCalled();
  });

  it('calls tasks.createStatus with the given fields', async () => {
    const createStatus = vi.fn(async () => STATUS_CONFIG);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { createStatus } }) });

    const code = await tasksCreateStatusHandler(
      ctx,
      commandIntent(['pg_list_1', '--name', 'Blocked', '--color', '#f00', '--group', 'in_progress', '--position', '3']),
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(createStatus).toHaveBeenCalledWith({ pageId: 'pg_list_1', name: 'Blocked', color: '#f00', group: 'in_progress', position: 3 });
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ tasks: { createStatus: async () => STATUS_CONFIG } }) });

    await tasksCreateStatusHandler(ctx, commandIntent(['pg_list_1', '--name', 'Blocked', '--color', '#f00', '--group', 'in_progress', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(STATUS_CONFIG);
  });
});

describe('tasksAssignedHandler', () => {
  it('calls tasks.getAssigned with no filters', async () => {
    const getAssigned = vi.fn(async () => ASSIGNED_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ tasks: { getAssigned } }) });

    const code = await tasksAssignedHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_SUCCESS);
    expect(getAssigned).toHaveBeenCalledWith({});
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ tasks: { getAssigned: async () => ASSIGNED_RESULT } }) });

    await tasksAssignedHandler(ctx, commandIntent(['--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(ASSIGNED_RESULT);
  });

  it('renders assigned tasks in human mode', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ tasks: { getAssigned: async () => ASSIGNED_RESULT } }) });

    await tasksAssignedHandler(ctx, commandIntent([]));

    const output = stdout.lines.join('');
    expect(output).toContain('task_1');
    expect(output).toContain('RED — write tests');
  });

  it('renders a friendly message when there are no assigned tasks', async () => {
    const stdout = createRecordingSink();
    const empty = { ...ASSIGNED_RESULT, tasks: [] };
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ tasks: { getAssigned: async () => empty } }) });

    await tasksAssignedHandler(ctx, commandIntent([]));

    expect(stdout.lines.join('')).toMatch(/no assigned tasks/i);
  });
});
