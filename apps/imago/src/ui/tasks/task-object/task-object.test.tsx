// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
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
        dueDate: '2026-10-09T12:00:00.000Z',
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

beforeEach(() => {
  setUiState(createInitialState());
  localStorage.clear();
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

/** Picks an option the way the browser does: set the value, then `change`. */
const choose = (select: HTMLSelectElement, value: string): void => {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const openTask = async (routes: Record<string, FakeRoute> = server(), withTree = false, title = 'Plan launch') => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <div data-detail="">
        <TaskObject driveId="d1" pageId="page-p" viewerId="u-1" />
      </div>
      {withTree ? (
        <div data-tree="">
          <TaskListView driveId="d1" pageId="l1" viewerId="u-1" />
        </div>
      ) : null}
    </ImagoSWRProvider>,
  );
  const detail = container.querySelector('[data-detail]') as HTMLElement;
  await settle(() => {
    if (field<HTMLInputElement>(detail, 'Title')?.value !== title) throw new Error('no task');
    if (!detail.querySelector('[aria-label="Assign Bo"]')) throw new Error('no assignable people');
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
    const status = field<HTMLSelectElement>(detail, 'Status');
    const subtasks = detail.querySelector('[aria-label="Subtasks"]');
    assert({
      given: '/d1/tasks/page-p, the page of task p in list Launch',
      should: 'show its title, status, priority, due date, assignees, description and subtasks',
      actual: {
        crumbs: detail.querySelector('nav[aria-label="Task path"]')?.textContent,
        title: field<HTMLInputElement>(detail, 'Title')?.value,
        complete: field(detail, 'Complete Plan launch')?.getAttribute('aria-checked'),
        status: status?.value,
        statuses: [...(status?.options ?? [])].map((option) => option.textContent),
        priority: field<HTMLSelectElement>(detail, 'Priority')?.value,
        due: field<HTMLInputElement>(detail, 'Due date')?.value,
        assignees: field(detail, 'Assigned to Ada')?.getAttribute('role'),
        description: descriptionOf(detail)?.innerHTML.includes('<strong>team</strong>'),
        subtasksHeading: subtasks?.querySelector('h3')?.textContent,
        subtasks: [...(subtasks?.querySelectorAll('[data-title]') ?? [])].map((node) => node.textContent),
      },
      expected: {
        crumbs: 'Launch',
        title: 'Plan launch',
        complete: 'false',
        status: 'pending',
        statuses: ['To Do', 'In Progress', 'Blocked', 'Done'],
        priority: 'medium',
        due: '2026-10-09',
        assignees: 'img',
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

    choose(field<HTMLSelectElement>(detail, 'Priority') as HTMLSelectElement, 'high');
    typeInto(field<HTMLInputElement>(detail, 'Due date') as HTMLInputElement, '2026-11-02');
    await settle(() => {
      if (field<HTMLInputElement>(detail, 'Due date')?.value !== '2026-11-02') throw new Error('due');
    });
    click(field<HTMLButtonElement>(detail, 'Assign Bo') as HTMLButtonElement);
    await settle(() => {
      if (field(detail, 'Assigned to Ada, Bo') === null) throw new Error('assignees');
    });
    choose(field<HTMLSelectElement>(detail, 'Status') as HTMLSelectElement, 'in_progress');
    await settle(() => {
      if (field<HTMLSelectElement>(detail, 'Status')?.value !== 'in_progress') throw new Error('status');
    });
    click(field<HTMLButtonElement>(detail, 'Clear due date') as HTMLButtonElement);
    await settle(() => {
      if (field<HTMLInputElement>(detail, 'Due date')?.value !== '') throw new Error('cleared');
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
        ['PATCH', '/api/pages/l1/tasks/p', { dueDate: '2026-11-02T12:00:00.000Z' }],
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
    click(field<HTMLButtonElement>(detail, 'Complete Book venue') as HTMLButtonElement);
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
    click(field<HTMLButtonElement>(detail, 'Complete Plan launch') as HTMLButtonElement);
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
    click(field<HTMLButtonElement>(detail, 'Assign Ada') as HTMLButtonElement);
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
        javascriptLinks: [...description.querySelectorAll('a')].filter((anchor) =>
          (anchor.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:'),
        ).length,
        pwned: (window as unknown as { pwned?: number }).pwned,
      },
      expected: { script: null, handlers: false, javascriptLinks: 0, pwned: undefined },
    });
  });

  test('editing it', async () => {
    const { web, detail } = await openTask();
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
        <TaskObject driveId="d1" pageId="page-p" viewerId="u-1" />
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

describe('TaskObject: what the id names', () => {
  const mountId = (pageId: string, routes: Record<string, FakeRoute>) => {
    const web = fakeWeb(routes);
    return mount(
      <ImagoSWRProvider client={web.client}>
        <TaskObject driveId="d1" pageId={pageId} viewerId="u-1" />
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

  test('not a task', async () => {
    const container = mountId('doc', {
      ...server(),
      'GET /api/pages/doc/breadcrumbs': () => Response.json([{ id: 'doc', title: 'Notes', type: 'DOCUMENT', parentId: null }]),
    });
    await settle(() => {
      if (!container.textContent?.includes('This task could not be found.')) throw new Error('not missing');
    });
    assert({
      given: 'an id that is neither a list nor a task in one',
      should: 'say the task could not be found',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'This task could not be found.',
    });
  });

  test('a task gone from its list', async () => {
    const container = mountId('page-p', {
      ...server(),
      'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json(taskListResponse([])),
    });
    await settle(() => {
      if (!container.textContent?.includes('This task could not be found.')) throw new Error('not missing');
    });
    assert({
      given: 'a task page its list no longer holds',
      should: 'say the task could not be found',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'This task could not be found.',
    });
  });

  test('a list that fails to load', async () => {
    const container = mountId('page-p', {
      ...server(),
      'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json({ error: 'boom' }, { status: 500 }),
    });
    await settle(() => {
      if (!container.textContent?.includes('Could not load this task.')) throw new Error('no error');
    });
    assert({
      given: 'the list holding the task fails to load',
      should: 'say so',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Could not load this task.',
    });
  });

  test('drive lists that fail to load', async () => {
    const container = mountId('page-p', {
      ...server(),
      [DRIVE]: () => Response.json({ error: 'boom' }, { status: 500 }),
    });
    await settle(() => {
      if (!container.textContent?.includes('Could not load this task.')) throw new Error('no error');
    });
    assert({
      given: 'the drive’s task lists fail to load',
      should: 'say the task could not load rather than wait forever',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Could not load this task.',
    });
  });
});

