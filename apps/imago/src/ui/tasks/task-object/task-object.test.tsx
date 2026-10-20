// @vitest-environment jsdom
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Editor } from '@tiptap/core';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { blur, click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { fakeWeb, type FakeRoute, type Recorded } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import type { TaskItemResponse } from '../task-model/task';
import { TaskListView } from '../task-list-view/task-list-view';
import { TaskObject } from './task-object';

const push = vi.hoisted(() => vi.fn());
// The list's Statuses and Workflows are classic's dialogs, covered where they live.
vi.mock('../task-list-view/task-list-tools', () => ({ TaskListTools: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

// TaskObject's list branch is a dispatch boundary; the reused list's writes are covered by the live port suite.
vi.mock('@/ui/files/page-view/page-view', () => ({ PageView: () => <><h2>Launch</h2><ul aria-label="Launch tasks" /></> }));
const DRIVE = 'GET /api/drives/d1/pages?ls=true&recursive=true';

const people: Readonly<Record<string, { readonly type: 'user' | 'agent'; readonly name: string }>> = {
  'u-ada': { type: 'user', name: 'Ada' },
  'u-bo': { type: 'user', name: 'Bo' },
  'ag-1': { type: 'agent', name: 'Planner' },
};

const assigneeRows = (taskId: string, ids: readonly { type: string; id: string }[]) =>
  ids.map(({ type, id }) => ({
    id: `row-${id}`,
    taskId,
    userId: type === 'user' ? id : null,
    agentPageId: type === 'agent' ? id : null,
    user: type === 'user' ? { id, name: people[id]?.name ?? null, image: null } : null,
    agentPage: type === 'agent' ? { id, title: people[id]?.name ?? null, type: 'AI_CHAT' } : null,
  }));

/**
 * apps/web's task routes over a little state: list l1 "Launch" holds parent
 * p "Plan launch" (Ada on it, one open subtask a) and leaf z. A PATCH or POST
 * changes what the next GET answers, so a revalidation shows what was saved.
 */
const server = (overrides: Record<string, FakeRoute> = {}) => {
  const lists: Record<string, TaskItemResponse[]> = {
    l1: [
      taskItem('p', {
        title: 'Plan launch',
        subTaskCount: 1,
        position: 0,
        // 9 October as classic stores it from Berlin: local midnight, the 8th in UTC.
        dueDate: '2026-10-08T22:00:00.000Z',
        assignees: assigneeRows('p', [{ type: 'user', id: 'u-ada' }]),
      }),
      taskItem('z', { title: 'Book venue', position: 1 }),
    ],
    'page-p': [taskItem('a', { title: 'Draft copy' })],
  };
  let content = '<p>Hello <strong>team</strong></p>';

  const patch =
    (listPageId: string, id: string): FakeRoute =>
    ({ body }: Recorded) => {
      const changes = body as Partial<TaskItemResponse> & { assigneeIds?: { type: string; id: string }[] };
      lists[listPageId] = (lists[listPageId] ?? []).map((item) => {
        if (item.id !== id) return item;
        const { assigneeIds, ...fields } = changes;
        return {
          ...item,
          ...fields,
          ...(fields.status === undefined ? {} : { completedAt: fields.status === 'completed' ? 'now' : null }),
          ...(assigneeIds === undefined ? {} : { assignees: assigneeRows(id, assigneeIds) }),
        };
      });
      return Response.json(lists[listPageId]?.find((item) => item.id === id));
    };

  const routes: Record<string, FakeRoute> = {
    'GET /api/pages/l1': () => Response.json({ id: 'l1', driveId: 'd1', type: 'TASK_LIST', title: 'Launch' }),
    [DRIVE]: () =>
      Response.json({
        mode: 'ls',
        pages: [
          { id: 'l1', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false },
          { id: 'page-p', title: 'Plan launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: true },
        ],
      }),
    'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json(taskListResponse(lists.l1 ?? [])),
    'GET /api/pages/page-p/tasks?limit=200&offset=0': () => Response.json(taskListResponse(lists['page-p'] ?? [])),
    'GET /api/pages/page-p/breadcrumbs': () =>
      Response.json([
        { id: 'l1', title: 'Launch', type: 'TASK_LIST', parentId: null, driveId: 'd1', drive: null },
        { id: 'page-p', title: 'Plan launch', type: 'TASK_LIST', parentId: 'l1', driveId: 'd1', drive: null },
      ]),
    'GET /api/drives/d1/assignees': () =>
      Response.json({
        assignees: Object.entries(people).map(([id, { type, name }]) => ({ id, type, name, image: null })),
      }),
    'GET /api/pages/page-p': () => Response.json({ id: 'page-p', content }),
    'GET /api/pages/page-p/permissions/check': () =>
      Response.json({ canView: true, canEdit: true, canShare: false, canDelete: false }),
    'GET /api/pages/l1/permissions/check': () =>
      Response.json({ canView: true, canEdit: true, canShare: false, canDelete: true }),
    'DELETE /api/pages/l1/tasks/p': () => {
      lists.l1 = (lists.l1 ?? []).filter((item) => item.id !== 'p');
      return Response.json({ success: true });
    },
    'PATCH /api/pages/page-p': ({ body }) => {
      content = (body as { content: string }).content;
      return Response.json({ id: 'page-p' });
    },
    'PATCH /api/pages/l1/tasks/p': patch('l1', 'p'),
    'PATCH /api/pages/l1/tasks/z': patch('l1', 'z'),
    'PATCH /api/pages/page-p/tasks/a': patch('page-p', 'a'),
    'POST /api/pages/page-p/tasks': ({ body }) => {
      const created = taskItem('b', { title: (body as { title: string }).title, position: 1 });
      lists['page-p'] = [...(lists['page-p'] ?? []), created];
      lists.l1 = (lists.l1 ?? []).map((item) => (item.id === 'p' ? { ...item, subTaskCount: 2 } : item));
      return Response.json(created);
    },
    ...overrides,
  };
  return routes;
};

// East of UTC, where reading a due date's UTC day would show it a day early.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin';
});
afterAll(() => {
  process.env.TZ = zone;
});

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  setUiState(createInitialState());
  localStorage.clear();
  push.mockReset();
});

afterEach(unmountAll);

/** Waits for `check` to pass, letting React flush between tries. */
const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 150; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

const field = <T extends Element>(root: ParentNode, label: string): T | null =>
  root.querySelector<T>(`[aria-label="${label}"]`);

const descriptionOf = (root: ParentNode) => root.querySelector<HTMLElement>('[aria-label="Description"][contenteditable]');

const focus = (target: HTMLElement): void => {
  act(() => {
    target.focus();
  });
};

/** A field's chip in the detail's row, by the start of its accessible name or text. */
const chip = (root: ParentNode, name: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('[aria-label="Fields"] button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').startsWith(name),
  );
  if (found === undefined) throw new Error(`no ${name} chip`);
  return found;
};

/** Opens a field's menu from the keyboard and chooses an option by its name. */
const chooseFrom = (root: ParentNode, name: string, option: string): void => {
  press(chip(root, name), 'Enter');
  const item = [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${name}"] [role="menuitemradio"]`)].find(
    (entry) => entry.textContent === option,
  );
  if (item === undefined) throw new Error(`no ${option} in ${name}`);
  click(item);
};

/** The open popover by name: it is portalled to the body, outside the detail. */
const popover = (name: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);

const inPopover = (name: string, label: string): HTMLButtonElement => {
  const found = [...(popover(name)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.getAttribute('aria-label') === label || button.textContent === label,
  );
  if (found === undefined) throw new Error(`no ${label} in ${name}`);
  return found;
};

const escape = (name: string): void => {
  press(popover(name) as HTMLElement, 'Escape');
};

/** The Assignees chip: named by the faces on it, or Unassigned. */
const assigneesChip = (root: ParentNode): HTMLButtonElement =>
  (root.querySelector('[aria-label="Fields"] [aria-label^="Assigned to"]')?.closest('button') ??
    chip(root, 'Unassigned')) as HTMLButtonElement;

/** Opens the Assignees popover and waits for the drive's people to load into it. */
const openAssignees = async (root: ParentNode, waitFor: string): Promise<void> => {
  click(assigneesChip(root));
  await settle(() => {
    if (!popover('Assignees')?.querySelector(`[aria-label="Assign ${waitFor}"]`)) throw new Error('no assignable people');
  });
};

const openTask = async (routes: Record<string, FakeRoute> = server(), withTree = false, title = 'Plan launch') => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <div data-detail="">
        <TaskObject driveId="d1" pageId="page-p" viewerId="u-1" live={false} />
      </div>
      {withTree ? (
        <div data-tree="">
          <TaskListView driveId="d1" pageId="l1" viewerId="u-1" live={false} />
        </div>
      ) : null}
    </ImagoSWRProvider>,
  );
  const detail = container.querySelector('[data-detail]') as HTMLElement;
  await settle(() => {
    // A viewer who may edit gets the Title field; one who may not, the title as a heading.
    const shown = field<HTMLInputElement>(detail, 'Title')?.value ?? detail.querySelector('article h2')?.textContent;
    if (shown !== title) throw new Error('no task');
    if (!descriptionOf(detail)?.textContent?.includes('Hello team')) throw new Error('no description');
  });
  const tree = container.querySelector('[data-tree]') as HTMLElement | null;
  if (tree !== null) {
    await settle(() => {
      if (!tree.textContent?.includes('Book venue')) throw new Error('no tree');
    });
  }
  return { web, detail, tree };
};

describe('TaskObject: a task', () => {
  test('its detail', async () => {
    const { detail } = await openTask();
    const subtasks = detail.querySelector('[aria-label="Subtasks"]');
    const status = chip(detail, 'Status').getAttribute('aria-label');
    press(chip(detail, 'Status'), 'Enter');
    const statuses = [...document.querySelectorAll('[role="menu"][aria-label="Status"] [role="menuitemradio"]')].map((item) => [
      item.textContent,
      item.getAttribute('aria-checked'),
    ]);
    press(document.querySelector('[role="menu"]') as HTMLElement, 'Escape');
    assert({
      given: '/d1/tasks/page-p, the page of task p in list Launch',
      should: 'show its title, status (with the list’s statuses in its menu), priority, dates, assignees, Delete, description and subtasks',
      actual: {
        crumbs: detail.querySelector('nav[aria-label="Task path"]')?.textContent,
        title: field<HTMLInputElement>(detail, 'Title')?.value,
        complete: field(detail, 'Mark Plan launch complete')?.getAttribute('aria-checked'),
        status,
        statuses,
        priority: chip(detail, 'Priority').getAttribute('aria-label'),
        // The chip names the day against the real clock: the month and year show only when they differ.
        due: /^Due · Fri 9( Oct( 2026)?)?$/.test(chip(detail, 'Due').textContent ?? ''),
        start: chip(detail, 'Set start date').textContent,
        assignees: field(detail, 'Assigned to Ada')?.getAttribute('role'),
        delete: field(detail, 'Delete task')?.tagName,
        description: descriptionOf(detail)?.innerHTML.includes('<strong>team</strong>'),
        subtasksHeading: subtasks?.querySelector('h3')?.textContent,
        subtasks: [...(subtasks?.querySelectorAll('[data-title]') ?? [])].map((node) => node.textContent),
      },
      expected: {
        crumbs: 'TasksLaunchPlan launch',
        title: 'Plan launch',
        complete: 'false',
        status: 'Status: To Do',
        statuses: [
          ['To Do', 'true'],
          ['In Progress', 'false'],
          ['Blocked', 'false'],
          ['Done', 'false'],
        ],
        priority: 'Priority: Medium',
        due: true,
        start: 'Set start date',
        assignees: 'img',
        delete: 'BUTTON',
        description: true,
        subtasksHeading: 'Subtasks · 0 of 1',
        subtasks: ['Draft copy'],
      },
    });
  });

  test('a subtask links to its own detail', async () => {
    const { detail } = await openTask();
    assert({
      given: 'a subtask in the detail',
      should: 'link to its own detail in the same drive',
      actual: detail.querySelector('[aria-label="Subtasks"] a[data-title]')?.getAttribute('href'),
      expected: '/d1/tasks/page-a',
    });
  });

  test('every field, edited in place', async () => {
    const { web, detail, tree } = await openTask(server(), true);
    const writes = () => web.writes().map(({ method, url, body }) => [method, url, body]);
    const treeTitles = () => [...(tree?.querySelectorAll('[data-title]') ?? [])].map((node) => node.textContent);

    const title = field<HTMLInputElement>(detail, 'Title') as HTMLInputElement;
    focus(title);
    typeInto(title, 'Plan the launch');
    press(title, 'Enter');
    await settle(() => {
      if (!treeTitles().includes('Plan the launch')) throw new Error('title not in tree');
    });

    chooseFrom(detail, 'Priority', 'High');
    await settle(() => {
      if (chip(detail, 'Priority').getAttribute('aria-label') !== 'Priority: High') throw new Error('priority');
    });
    click(chip(detail, 'Due'));
    click(inPopover('Due date', 'Next month'));
    click(inPopover('Due date', 'Monday, November 2, 2026'));
    await settle(() => {
      if (popover('Due date') !== null || !/^Due · Mon 2/.test(chip(detail, 'Due').textContent ?? '')) throw new Error('due');
    });
    await openAssignees(detail, 'Bo');
    click(inPopover('Assignees', 'Assign Bo'));
    await settle(() => {
      if (field(detail, 'Assigned to Ada, Bo') === null) throw new Error('assignees');
    });
    escape('Assignees');
    chooseFrom(detail, 'Status', 'In Progress');
    await settle(() => {
      if (chip(detail, 'Status').getAttribute('aria-label') !== 'Status: In Progress') throw new Error('status');
    });
    click(chip(detail, 'Due'));
    click(inPopover('Due date', 'Clear date'));
    await settle(() => {
      if (chip(detail, 'Set due date').textContent !== 'Set due date') throw new Error('cleared');
    });

    const adder = [...detail.querySelectorAll<HTMLButtonElement>('[aria-label="Subtasks"] button')].find(
      (button) => button.textContent === 'Add subtask',
    );
    click(adder as HTMLButtonElement);
    const add = detail.querySelector<HTMLInputElement>('[aria-label="Subtasks"] input[placeholder="Subtask title"]');
    typeInto(add as HTMLInputElement, 'Book press');
    press(add as HTMLInputElement, 'Enter');
    await settle(() => {
      if (!detail.querySelector('[aria-label="Subtasks"]')?.textContent?.includes('Book press')) {
        throw new Error('subtask');
      }
    });

    assert({
      given: 'the title, priority, due date, an assignee, the status, a cleared date and a new subtask',
      should: 'save each with its own write to the real task routes',
      actual: writes(),
      expected: [
        ['PATCH', '/api/pages/l1/tasks/p', { title: 'Plan the launch' }],
        ['PATCH', '/api/pages/l1/tasks/p', { priority: 'high' }],
        // 2 November's Berlin midnight, as classic's picker sends it.
        ['PATCH', '/api/pages/l1/tasks/p', { dueDate: '2026-11-01T23:00:00.000Z' }],
        [
          'PATCH',
          '/api/pages/l1/tasks/p',
          { assigneeIds: [{ type: 'user', id: 'u-ada' }, { type: 'user', id: 'u-bo' }] },
        ],
        ['PATCH', '/api/pages/l1/tasks/p', { status: 'in_progress' }],
        ['PATCH', '/api/pages/l1/tasks/p', { dueDate: null }],
        ['POST', '/api/pages/page-p/tasks', { title: 'Book press' }],
      ],
    });

    const expand = tree?.querySelector<HTMLButtonElement>('[aria-label="Toggle Plan the launch"]');
    click(expand as HTMLButtonElement);
    assert({
      given: 'the same list open in the Tree view',
      should: 'show the new title and the new subtask there too',
      actual: treeTitles(),
      expected: ['Plan the launch', 'Draft copy', 'Book press', 'Book venue'],
    });
  });

  test('ticking from the detail', async () => {
    // A leaf: list l1 holds only z, whose own page is page-p.
    let status = 'pending';
    const leaf = () => taskItem('z', { title: 'Book venue', pageId: 'page-p', status });
    const { web, detail, tree } = await openTask(
      server({
        'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json(taskListResponse([leaf()])),
        'PATCH /api/pages/l1/tasks/z': ({ body }) => {
          status = (body as { status: string }).status;
          return Response.json(leaf());
        },
      }),
      true,
      'Book venue',
    );
    click(field<HTMLButtonElement>(detail, 'Mark Book venue complete') as HTMLButtonElement);
    await settle(() => {
      if (tree?.querySelector('[aria-label="Complete Book venue"]')?.getAttribute('aria-checked') !== 'true') {
        throw new Error('not ticked in tree');
      }
    });
    assert({
      given: 'a leaf task ticked in its detail',
      should: 'save it done and tick it in the tree',
      actual: web.writes().map(({ url, body }) => [url, body]),
      expected: [['/api/pages/l1/tasks/z', { status: 'completed' }]],
    });
  });

  test('a parent with an open subtask', async () => {
    const { web, detail } = await openTask();
    click(field<HTMLButtonElement>(detail, 'Mark Plan launch complete') as HTMLButtonElement);
    await settle(() => {
      if (!detail.textContent?.includes('Complete all sub-tasks first')) throw new Error('no refusal');
    });
    assert({
      given: 'completing a task whose subtask is open',
      should: 'refuse it as the server would, without a request',
      actual: { writes: web.writes().length, notice: detail.querySelector('[role="status"]')?.textContent },
      expected: { writes: 0, notice: 'Complete all sub-tasks first (1 of 1 remaining)' },
    });
  });

  test('a blank title', async () => {
    const { web, detail } = await openTask();
    const title = field<HTMLInputElement>(detail, 'Title') as HTMLInputElement;
    focus(title);
    typeInto(title, '   ');
    blur(title);
    await settle(() => {
      if (title.value !== 'Plan launch') throw new Error('not restored');
    });
    assert({
      given: 'the title emptied and left',
      should: 'send nothing and put the title back',
      actual: { writes: web.writes().length, title: title.value },
      expected: { writes: 0, title: 'Plan launch' },
    });
  });

  test('Escape on the title', async () => {
    const { web, detail } = await openTask();
    const title = field<HTMLInputElement>(detail, 'Title') as HTMLInputElement;
    focus(title);
    typeInto(title, 'Something else');
    press(title, 'Escape');
    blur(title);
    await settle(() => {
      if (title.value !== 'Plan launch') throw new Error('not restored');
    });
    assert({
      given: 'a title edit abandoned with Escape',
      should: 'send nothing and put the title back',
      actual: { writes: web.writes().length, title: title.value },
      expected: { writes: 0, title: 'Plan launch' },
    });
  });

  test('taking an assignee off', async () => {
    const { web, detail } = await openTask();
    await openAssignees(detail, 'Ada');
    click(inPopover('Assignees', 'Assign Ada'));
    await settle(() => {
      if (detail.textContent?.includes('Unassigned') !== true) throw new Error('still assigned');
    });
    assert({
      given: 'the only assignee unticked',
      should: 'save an empty set and show the task unassigned',
      actual: web.writes().map(({ body }) => body),
      expected: [{ assigneeIds: [] }],
    });
  });
});

describe('TaskObject: the detail’s popovers', () => {
  test('filtering the people', async () => {
    const { detail } = await openTask();
    await openAssignees(detail, 'Bo');
    const names = () =>
      [...(popover('Assignees')?.querySelectorAll('[role="group"]') ?? [])].map((group) => [
        group.getAttribute('aria-label'),
        [...group.querySelectorAll('[role="checkbox"]')].map((box) => [box.getAttribute('aria-label')?.replace('Assign ', ''), box.getAttribute('aria-checked')]),
      ]);
    const all = names();
    const filter = popover('Assignees')?.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    typeInto(filter, 'plan');
    const agents = names();
    typeInto(filter, 'zz');
    assert({
      given: 'the Assignees popover, filtered by "plan" and then by "zz"',
      should: 'group Members and Agents with Ada ticked, narrow to the matching agent, then say no one matches',
      actual: { all, agents, none: popover('Assignees')?.textContent?.includes('No one matches') },
      expected: {
        all: [
          [
            'Members',
            [
              ['Ada', 'true'],
              ['Bo', 'false'],
            ],
          ],
          ['Agents', [['Planner', 'false']]],
        ],
        agents: [['Agents', [['Planner', 'false']]]],
        none: true,
      },
    });
  });

  test('a start date', async () => {
    const { web, detail } = await openTask();
    click(chip(detail, 'Set start date'));
    const after = inPopover('Start date', 'Saturday, October 10, 2026').disabled;
    click(inPopover('Start date', 'Monday, October 5, 2026'));
    await settle(() => {
      if (!/^Start · Mon 5/.test(chip(detail, 'Start').textContent ?? '')) throw new Error('start');
    });
    click(chip(detail, 'Due'));
    const before = inPopover('Due date', 'Sunday, October 4, 2026').disabled;
    assert({
      given: 'a start date picked on a task due October 9',
      should: 'refuse days after the due date, save the 5th as Berlin’s midnight, then refuse due days before it',
      actual: { after, writes: web.writes().map(({ url, body }) => [url, body]), before },
      expected: {
        after: true,
        writes: [['/api/pages/l1/tasks/p', { startDate: '2026-10-04T22:00:00.000Z' }]],
        before: true,
      },
    });
  });

  test('deleting the task', async () => {
    const { web, detail } = await openTask();
    click(field<HTMLButtonElement>(detail, 'Delete task') as HTMLButtonElement);
    const question = popover('Delete task')?.textContent?.includes('Delete this task and its subtasks?');
    click(inPopover('Delete task', 'Cancel'));
    const cancelled = { open: popover('Delete task'), writes: web.writes().length };
    click(field<HTMLButtonElement>(detail, 'Delete task') as HTMLButtonElement);
    click(inPopover('Delete task', 'Delete'));
    await settle(() => {
      if (push.mock.calls.length === 0) throw new Error('not left');
    });
    assert({
      given: 'Delete asked, cancelled, then asked again and confirmed',
      should: 'ask first, send nothing on Cancel, then DELETE the task and open its list',
      actual: { question, cancelled, writes: web.writes().map(({ method, url }) => [method, url]), to: push.mock.calls[0]?.[0] },
      expected: {
        question: true,
        cancelled: { open: null, writes: 0 },
        writes: [['DELETE', '/api/pages/l1/tasks/p']],
        to: '/d1/tasks/l1',
      },
    });
  });

  test('a refused delete', async () => {
    const { detail } = await openTask(
      server({ 'DELETE /api/pages/l1/tasks/p': () => Response.json({ error: 'Not allowed' }, { status: 403 }) }),
    );
    click(field<HTMLButtonElement>(detail, 'Delete task') as HTMLButtonElement);
    click(inPopover('Delete task', 'Delete'));
    await settle(() => {
      if (!detail.textContent?.includes('Not allowed')) throw new Error('no refusal');
    });
    assert({
      given: 'a delete the server refuses',
      should: 'keep the task open, say why under its title, and stay put',
      actual: {
        title: field<HTMLInputElement>(detail, 'Title')?.value,
        notice: detail.querySelector('[role="status"]')?.textContent,
        pushed: push.mock.calls.length,
      },
      expected: { title: 'Plan launch', notice: 'Not allowed', pushed: 0 },
    });
  });

  test('a viewer who may not edit the list', async () => {
    const { web, detail } = await openTask(
      server({
        'GET /api/pages/l1/permissions/check': () =>
          Response.json({ canView: true, canEdit: false, canShare: false, canDelete: false }),
      }),
    );
    await settle(() => {
      if (web.count('GET /api/pages/l1/permissions/check') === 0) throw new Error('not asked');
    });
    await settle(() => {});
    assert({
      given: 'a viewer the server says cannot edit the list',
      should: 'not offer Delete, a Title field or any field control',
      actual: {
        delete: field(detail, 'Delete task'),
        title: field(detail, 'Title'),
        controls: detail.querySelectorAll('[aria-label="Fields"] button').length,
      },
      expected: { delete: null, title: null, controls: 0 },
    });
  });
});

describe('TaskObject: the description', () => {
  test('unsafe markup', async () => {
    const routes = server({
      'GET /api/pages/page-p': () =>
        Response.json({
          id: 'page-p',
          content:
            '<p>Hello <strong>team</strong></p><script>window.pwned = 1</script><img src="x" onerror="window.pwned = 1"><p><a href="javascript:alert(1)">link</a></p>',
        }),
    });
    const { detail } = await openTask(routes);
    const description = descriptionOf(detail) as HTMLElement;
    assert({
      given: 'a description holding a script, an onerror handler and a javascript: link',
      should: 'render it through the editor schema, with none of them live',
      actual: {
        script: description.querySelector('script'),
        handlers: [...description.querySelectorAll('*')].some((node) =>
          [...node.attributes].some((attribute) => attribute.name.startsWith('on')),
        ),
        scriptUrlLinks: [...description.querySelectorAll('a')].filter((anchor) =>
          /^(?:javascript|vbscript|data):/i.test((anchor.getAttribute('href') ?? '').trim()),
        ).length,
        pwned: (window as unknown as { pwned?: number }).pwned,
      },
      expected: { script: null, handlers: false, scriptUrlLinks: 0, pwned: undefined },
    });
  });

  test('editing it', async () => {
    const { web, detail } = await openTask();
    await settle(() => {
      if (descriptionOf(detail)?.getAttribute('contenteditable') !== 'true') throw new Error('not editable');
    });
    const description = descriptionOf(detail) as HTMLElement & { editor?: Editor };
    act(() => {
      description.editor?.commands.setContent('<p>Rewritten</p>', { emitUpdate: true });
    });
    act(() => {
      description.dispatchEvent(new FocusEvent('blur'));
    });
    await settle(() => {
      if (web.writes().length === 0) throw new Error('not saved');
    });
    const [write] = web.writes();
    assert({
      given: 'the description rewritten and left',
      should: 'PATCH the task’s own page with the new content',
      actual: { method: write?.method, url: write?.url, saved: (write?.body as { content: string }).content.includes('Rewritten') },
      expected: { method: 'PATCH', url: '/api/pages/page-p', saved: true },
    });
  });

  test('a refused save', async () => {
    const { detail } = await openTask(
      server({
        'PATCH /api/pages/page-p': () => Response.json({ error: 'You need edit permission' }, { status: 403 }),
      }),
    );
    await settle(() => {
      if (descriptionOf(detail)?.getAttribute('contenteditable') !== 'true') throw new Error('not editable');
    });
    const description = descriptionOf(detail) as HTMLElement & { editor?: Editor };
    act(() => {
      description.editor?.commands.setContent('<p>Mine</p>', { emitUpdate: true });
    });
    act(() => {
      description.dispatchEvent(new FocusEvent('blur'));
    });
    await settle(() => {
      if (!detail.textContent?.includes('You need edit permission')) throw new Error('no refusal');
    });
    assert({
      given: 'a description save the server refuses',
      should: 'say why under the description',
      actual: detail.querySelector('[data-description-notice]')?.textContent,
      expected: 'You need edit permission',
    });
  });

  test('content that fails to load', async () => {
    const web = fakeWeb(
      server({ 'GET /api/pages/page-p': () => Response.json({ error: 'nope' }, { status: 500 }) }),
    );
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <TaskObject driveId="d1" pageId="page-p" viewerId="u-1" live={false} />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.textContent?.includes('Could not load the description.')) throw new Error('no error');
    });
    assert({
      given: 'a description that fails to load',
      should: 'say so in its place and keep the rest of the task',
      actual: { title: field<HTMLInputElement>(container, 'Title')?.value, editor: descriptionOf(container) },
      expected: { title: 'Plan launch', editor: null },
    });
  });
});

describe('TaskObject: who may edit the description', () => {
  test('a viewer without edit rights', async () => {
    const { web, detail } = await openTask(
      server({
        'GET /api/pages/page-p/permissions/check': () =>
          Response.json({ canView: true, canEdit: false, canShare: false, canDelete: false }),
      }),
    );
    await settle(() => {
      if (web.count('GET /api/pages/page-p/permissions/check') === 0) throw new Error('not asked');
    });
    const description = descriptionOf(detail) as HTMLElement & { editor?: Editor };
    act(() => {
      description.editor?.commands.setContent('<p>Typed anyway</p>', { emitUpdate: true });
    });
    act(() => {
      description.dispatchEvent(new FocusEvent('blur'));
    });
    await settle(() => {});
    assert({
      given: 'a viewer the server says cannot edit the task’s page',
      should: 'show the description read-only and save nothing from it',
      actual: { editable: description.getAttribute('contenteditable'), writes: web.writes().length },
      expected: { editable: 'false', writes: 0 },
    });
  });

  test('before the answer', async () => {
    const { detail } = await openTask(
      server({ 'GET /api/pages/page-p/permissions/check': () => new Promise<Response>(() => {}) }),
    );
    assert({
      given: 'edit rights not known yet',
      should: 'keep the description read-only until a definite yes',
      actual: descriptionOf(detail)?.getAttribute('contenteditable'),
      expected: 'false',
    });
  });

  test('a viewer with edit rights', async () => {
    const { detail } = await openTask();
    await settle(() => {
      if (descriptionOf(detail)?.getAttribute('contenteditable') !== 'true') throw new Error('not editable');
    });
    assert({
      given: 'a viewer who may edit the task’s page',
      should: 'make the description editable',
      actual: descriptionOf(detail)?.getAttribute('contenteditable'),
      expected: 'true',
    });
  });
});

describe('TaskObject: what the id names', () => {
  const mountId = (pageId: string, routes: Record<string, FakeRoute>) => {
    const web = fakeWeb(routes);
    return mount(
      <ImagoSWRProvider client={web.client}>
        <TaskObject driveId="d1" pageId={pageId} viewerId="u-1" live={false} />
      </ImagoSWRProvider>,
    );
  };

  test('a list', async () => {
    const container = mountId('l1', server());
    await settle(() => {
      if (container.querySelector('h2')?.textContent !== 'Launch') throw new Error('no list');
    });
    assert({
      given: 'the id of a drive task list',
      should: 'open the list',
      actual: container.querySelector('ul')?.getAttribute('aria-label'),
      expected: 'Launch tasks',
    });
  });

  test('loading', () => {
    const container = mountId('page-p', { [DRIVE]: () => new Promise<Response>(() => {}) });
    assert({
      given: 'a task id before anything loads',
      should: 'say it is loading',
      actual: container.querySelector('[role="status"]')?.textContent,
      expected: 'Loading task…',
    });
  });

  const notFound = (container: HTMLElement) => {
    const object = container.querySelector('[data-not-found]');
    return [object?.querySelector('h2')?.textContent, object?.querySelector('a')?.getAttribute('href'), object?.querySelector('a')?.textContent];
  };

  const failed = (container: HTMLElement) => {
    const alert = container.querySelector('[role="alert"][data-error]');
    return [alert?.querySelector('h2')?.textContent, alert?.querySelector('button')?.textContent, alert?.textContent?.includes('boom')];
  };

  test('not a task', async () => {
    const container = mountId('doc', {
      ...server(),
      'GET /api/pages/doc/breadcrumbs': () => Response.json([{ id: 'doc', title: 'Notes', type: 'DOCUMENT', parentId: null }]),
    });
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('not missing');
    });
    assert({
      given: 'an id that is neither a list nor a task in one',
      should: 'draw the not-found object with a way back to the drive’s task lists',
      actual: notFound(container),
      expected: ['Task not found', '/d1/tasks', 'Back to Tasks'],
    });
  });

  test('an id the server will not place', async () => {
    const container = mountId('nope', {
      ...server(),
      'GET /api/pages/nope/breadcrumbs': () => Response.json({ error: 'Page not found' }, { status: 404 }),
    });
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('not missing');
    });
    assert({
      given: 'an id whose ancestors the server answers 404 for',
      should: 'draw the not-found object',
      actual: notFound(container)[0],
      expected: 'Task not found',
    });
  });

  test('a task gone from its list', async () => {
    const container = mountId('page-p', {
      ...server(),
      'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json(taskListResponse([])),
    });
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('not missing');
    });
    assert({
      given: 'a task page its list no longer holds',
      should: 'draw the not-found object',
      actual: notFound(container),
      expected: ['Task not found', '/d1/tasks', 'Back to Tasks'],
    });
  });

  test('a list that fails to load', async () => {
    const container = mountId('page-p', {
      ...server(),
      'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json({ error: 'boom' }, { status: 500 }),
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"][data-error]')) throw new Error('no error');
    });
    assert({
      given: 'the list holding the task fails to load',
      should: 'draw the retryable error object without the server’s text',
      actual: failed(container),
      expected: ['Could not load this task', 'Try again', false],
    });
  });

  test('ancestors that fail to load', async () => {
    const container = mountId('nope', {
      ...server(),
      'GET /api/pages/nope/breadcrumbs': () => Response.json({ error: 'boom' }, { status: 503 }),
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"][data-error]')) throw new Error('no error');
    });
    assert({
      given: 'an id whose ancestors fail to load',
      should: 'draw the retryable error, not not-found',
      actual: failed(container),
      expected: ['Could not load this task', 'Try again', false],
    });
  });

  test('drive lists that fail to load, then load', async () => {
    let calls = 0;
    const table = server();
    const container = mountId('page-p', {
      ...table,
      [DRIVE]: (request) => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'boom' }, { status: 503 }) : table[DRIVE](request);
      },
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"][data-error]')) throw new Error('no error');
    });
    const before = failed(container);
    click(container.querySelector('[role="alert"] button') as HTMLButtonElement);
    await settle(() => {
      if (field<HTMLInputElement>(container, 'Title')?.value !== 'Plan launch') throw new Error('no task');
    });
    assert({
      given: 'the drive’s task lists fail, then Try again',
      should: 'draw the retryable error rather than wait forever, then the task once SWR reloads the lists',
      actual: [before, calls],
      expected: [['Could not load this task', 'Try again', false], 2],
    });
  });
});


describe('TaskObject: a task’s automations and activity', () => {
  const trigger = {
    id: 'trg-1',
    triggerType: 'due_date',
    nextRunAt: '2026-11-14T08:00:00.000Z',
    lastFiredAt: null,
    lastFireError: null,
    isEnabled: true,
    agentPageId: 'ag-1',
    prompt: 'Remind the launch team',
  };
  const activities = {
    activities: [
      {
        id: 'act-1',
        timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        operation: 'update',
        actorDisplayName: 'Imago',
        isAiGenerated: true,
        updatedFields: ['dueDate'],
        user: null,
      },
    ],
  };
  const ACTIVITY = 'GET /api/activities?context=page&pageId=page-p&limit=20';

  test('a task with a due trigger, and the AI’s due-date change', async () => {
    const { detail } = await openTask({
      ...server(),
      'GET /api/tasks/p/triggers': () => Response.json({ triggers: [trigger] }),
      [ACTIVITY]: () => Response.json(activities),
    });
    await settle(() => {
      if (!detail.querySelector('[aria-label="Activity"]')) throw new Error('no activity');
    });
    const automations = detail.querySelector('[aria-label="Automations"]');
    assert({
      given: 'a task whose due trigger runs with the drive’s agent, and an AI change to its due date',
      should: 'show the due trigger with its agent, offer the completion placeholder, enable the switch, list Imago’s change, and say the due date was set by Imago',
      actual: {
        rows: automations?.textContent?.includes('When due → run with Planner'),
        completionPlaceholder: automations?.textContent?.includes('On completion → run a workflow…'),
        enabled: automations?.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
        activity: detail.querySelector('[aria-label="Activity"]')?.textContent?.includes('Imago set due date'),
        dueNote: detail.textContent?.includes('set by Imago'),
      },
      expected: { rows: true, completionPlaceholder: true, enabled: 'true', activity: true, dueNote: true },
    });
  });

  test('a viewer who may not edit the list', async () => {
    const { detail } = await openTask({
      ...server(),
      'GET /api/tasks/p/triggers': () => Response.json({ error: 'Forbidden' }, { status: 403 }),
      [ACTIVITY]: () => Response.json(activities),
    });
    await settle(() => {
      if (!detail.querySelector('[aria-label="Activity"]')) throw new Error('no activity');
    });
    assert({
      given: 'a viewer whose triggers request is refused with 403',
      should: 'hide the Automations section and still show the activity',
      actual: {
        automations: detail.querySelector('[aria-label="Automations"]') === null,
        activity: detail.querySelector('[aria-label="Activity"]') !== null,
      },
      expected: { automations: true, activity: true },
    });
  });

  test('the first of two tasks', async () => {
    const { detail } = await openTask({ ...server(), 'GET /api/tasks/p/triggers': () => Response.json({ triggers: [] }) });
    await settle(() => {
      if (!detail.querySelector('[aria-label="Automations"]')) throw new Error('no automations');
    });
    const previous = detail.querySelector<HTMLButtonElement>('[aria-label="Previous task"]');
    const next = detail.querySelector<HTMLAnchorElement>('[aria-label="Next task"]');
    assert({
      given: 'the first task of two in its list, with no triggers',
      should: 'disable Previous task, link Next task to the next task, say the edit was saved, and offer the completion trigger',
      actual: {
        previous: previous?.disabled,
        next: next?.getAttribute('href'),
        saved: detail.textContent?.includes('Saved'),
        placeholder: detail.querySelector('[aria-label="Automations"]')?.textContent?.includes('On completion → run a workflow…'),
        list: detail.querySelector('a[href="/d1/tasks/l1"]')?.textContent,
      },
      expected: { previous: true, next: '/d1/tasks/page-z', saved: true, placeholder: true, list: 'Launch' },
    });
  });
});
