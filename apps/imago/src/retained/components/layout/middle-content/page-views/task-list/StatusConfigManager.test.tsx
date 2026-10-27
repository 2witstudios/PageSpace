// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { StatusConfigManager } from './StatusConfigManager';
import type { TaskStatusConfig } from './task-list-types';

const spies = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  onConfigsChanged: vi.fn(),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  post: spies.post,
  put: spies.put,
  del: spies.del,
  fetchWithAuth: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const GREEN_CLASSES = 'bg-green-100';

const status = (overrides: Partial<TaskStatusConfig>): TaskStatusConfig => ({
  id: 's1',
  taskListId: 'p1',
  name: 'To do',
  slug: 'todo',
  color: 'bg-slate-100 text-slate-700',
  group: 'todo',
  position: 0,
  ...overrides,
});

const statuses: TaskStatusConfig[] = [
  status({}),
  status({ id: 's2', name: 'In progress', slug: 'in_progress', group: 'in_progress', position: 1 }),
  status({ id: 's3', name: 'Done', slug: 'done', group: 'done', position: 2 }),
];

const settle = async (check: () => void): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  check();
};

const openDialog = () => {
  const container = mount(
    createElement(StatusConfigManager, {
      pageId: 'p1',
      statusConfigs: statuses,
      onConfigsChanged: spies.onConfigsChanged,
    }),
  );
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Statuses',
  );
  if (trigger) click(trigger);
  return container;
};

const buttonsNamed = (name: string): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  );

const radio = (group: string, name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-label="${name}"]`) ??
  Array.from(document.querySelectorAll<HTMLElement>(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)).find(
    (el) => el.textContent?.trim() === name,
  ) ??
  null;

const groupHeadings = (): string[] =>
  Array.from(document.querySelectorAll('h4')).map((h) => h.textContent?.trim() ?? '');

beforeEach(() => {
  spies.post.mockResolvedValue({});
  spies.put.mockResolvedValue({});
  spies.del.mockResolvedValue({});
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

describe('StatusConfigManager', () => {
  test('lists each config under its group with its name, slug, Edit and Delete', async () => {
    openDialog();
    await settle(() => {
      assert({
        given: 'a list with one status in each group',
        should: 'show the Manage Status Categories title, the three group headings, and each row with Edit and Delete',
        actual: {
          title: document.body.textContent?.includes('Manage Status Categories') ?? false,
          groups: groupHeadings(),
          slug: document.body.textContent?.includes('in_progress') ?? false,
          edit: buttonsNamed('Edit To do').length,
          remove: buttonsNamed('Delete To do').length,
        },
        expected: {
          title: true,
          groups: ['Not Started', 'In Progress', 'Done'],
          slug: true,
          edit: 1,
          remove: 1,
        },
      });
    });
  });

  test('opens the add form by default with a name field, Group and Color choices, and Add Status disabled until named', async () => {
    openDialog();
    await settle(() => {
      const addButton = buttonsNamed('Add Status')[0];
      assert({
        given: 'the statuses dialog just opened',
        should: 'show the add form with Status name, a Group radio set defaulting to In Progress, twelve colour swatches defaulting to violet, and a disabled Add Status',
        actual: {
          name: document.querySelector<HTMLInputElement>('input[placeholder="Status name..."]') !== null,
          group: radio('Group', 'In Progress')?.getAttribute('aria-checked') ?? null,
          swatches: document.querySelectorAll('[role="radiogroup"][aria-label="Color"] [role="radio"]').length,
          violet: radio('Color', 'violet')?.getAttribute('aria-checked') ?? null,
          addDisabled: addButton?.disabled ?? null,
          openerHidden: buttonsNamed('Add status').length,
        },
        expected: {
          name: true,
          group: 'true',
          swatches: 12,
          violet: 'true',
          addDisabled: true,
          openerHidden: 0,
        },
      });
    });
  });

  test('Add Status POSTs the name, colour and group, then closes the form', async () => {
    openDialog();
    await settle(() => {});
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Status name..."]');
    if (input) typeInto(input, 'Waiting on legal');
    const done = radio('Group', 'Done');
    if (done) click(done);
    const green = radio('Color', 'green');
    if (green) click(green);
    const add = buttonsNamed('Add Status')[0];
    if (add) click(add);
    await settle(() => {
      const [url, body] = spies.post.mock.calls[0] ?? [];
      const payload = body as { name?: string; color?: string; group?: string } | undefined;
      assert({
        given: 'a name, the Done group and the green swatch chosen',
        should: 'POST the new status to the page statuses endpoint, notify the parent, and show the Add status button again',
        actual: {
          url,
          name: payload?.name,
          group: payload?.group,
          color: payload?.color?.startsWith(GREEN_CLASSES) ?? null,
          notified: spies.onConfigsChanged.mock.calls.length,
          opener: buttonsNamed('Add status').length,
        },
        expected: {
          url: '/api/pages/p1/tasks/statuses',
          name: 'Waiting on legal',
          group: 'done',
          color: true,
          notified: 1,
          opener: 1,
        },
      });
    });
  });

  test('Cancel closes the add form without posting', async () => {
    openDialog();
    await settle(() => {});
    const cancel = buttonsNamed('Cancel')[0];
    if (cancel) click(cancel);
    await settle(() => {
      assert({
        given: 'the add form is open',
        should: 'close the form, show Add status again, and POST nothing',
        actual: {
          input: document.querySelector('input[placeholder="Status name..."]') !== null,
          opener: buttonsNamed('Add status').length,
          posts: spies.post.mock.calls.length,
        },
        expected: { input: false, opener: 1, posts: 0 },
      });
    });
  });
});
