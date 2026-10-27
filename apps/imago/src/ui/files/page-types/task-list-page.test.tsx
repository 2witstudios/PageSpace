// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { TaskListPage } from './task-list-page';

const seen: Record<string, unknown>[] = [];

vi.mock('@/ui/tasks/task-list-view/task-list-view', async () => {
  const { createElement: h } = await import('react');
  return {
    TaskListView: (props: Record<string, unknown>) => {
      seen.push(props);
      return h('div', { 'data-testid': 'native-task-list' });
    },
  };
});

vi.mock('@/retained/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));

afterEach(() => {
  unmountAll();
  seen.length = 0;
});

const page = { id: 'p-1', title: 'Launch Tasks', type: 'TASK_LIST' } as unknown as TreePage;

describe('TaskListPage', () => {
  test('the native list view', () => {
    const container = mount(createElement(TaskListPage, { page, driveId: 'd-1', pageId: 'p-1' }));
    assert({
      given: 'a TASK_LIST page in the v3 middle',
      should: "draw imago's own list view, not classic's table",
      actual: container.querySelector('[data-testid="native-task-list"]') !== null,
      expected: true,
    });
  });

  test('who and what', () => {
    mount(createElement(TaskListPage, { page, driveId: 'd-1', pageId: 'p-1' }));
    assert({
      given: 'a signed-in viewer and a titled page',
      should: "pass the viewer's id and the page's own title through",
      actual: seen.map(({ driveId, pageId, viewerId, title }) => ({ driveId, pageId, viewerId, title })),
      expected: [{ driveId: 'd-1', pageId: 'p-1', viewerId: 'u-1', title: 'Launch Tasks' }],
    });
  });
});
