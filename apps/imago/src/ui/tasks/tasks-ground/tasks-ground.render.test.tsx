import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groundSections } from './ground-rows';
import { renderTasksGround, type TasksGroundRenderProps } from './tasks-ground.render';
import { taskItem } from '../task-model/fixtures';
import type { DriveTaskResponse } from '../task-model/task';

const noop = () => undefined;

const row = (id: string, extra: Partial<DriveTaskResponse> = {}): DriveTaskResponse => ({
  ...taskItem(id, { title: `Task ${id}` }),
  driveId: 'd1',
  taskListPageId: 'l1',
  taskListPageTitle: 'Launch Tasks',
  statusGroup: 'todo',
  statusLabel: 'To Do',
  statusColor: '',
  ...extra,
});

const html = (props: Partial<TasksGroundRenderProps> & Pick<TasksGroundRenderProps, 'state'>) =>
  renderToStaticMarkup(
    <>
      {renderTasksGround({
        heading: 'Assigned to you',
        subtitle: '2 tasks in 1 list',
        status: 'active',
        onStatus: noop,
        ...props,
      })}
    </>,
  );

describe('renderTasksGround()', () => {
  test('the heading, the status segment and the sections with their rows', () => {
    const markup = html({
      state: {
        kind: 'ready',
        sections: groundSections(
          [row('over', { dueDate: '2020-01-01T12:00:00' }), row('later', { statusGroup: 'done', statusLabel: 'Done' })],
          '2026-10-12',
        ),
      },
    });
    assert({
      given: 'an overdue task and a done one, Active selected',
      should: 'show the heading, the Active · Completed · All segment with Active pressed, and only the non-empty sections',
      actual: {
        heading: markup.includes('<h2') && markup.includes('Assigned to you'),
        segment: ['Active', 'Completed', 'All'].map((label) => markup.includes('aria-label="Status"') && markup.includes(`>${label}<`)),
        pressed: /aria-pressed="true"[^>]*>Active</.test(markup) && !/aria-pressed="true"[^>]*>Completed</.test(markup),
        sections: ['Overdue', 'Due this week', 'Later'].map((name) => markup.includes(`aria-label="${name}"`)),
        complete: markup.includes('role="img" aria-label="Priority medium"'),
        link: markup.includes('href="/d1/tasks/page-over"'),
      },
      expected: {
        heading: true,
        segment: [true, true, true],
        pressed: true,
        sections: [true, false, true],
        complete: true,
        link: true,
      },
    });
  });

  test('a row from another drive on Home', () => {
    const markup = html({
      state: { kind: 'ready', sections: groundSections([row('x', { driveId: 'd2' })], '2026-10-12', new Map([['d2', 'Launch']])) },
    });
    assert({
      given: 'a task in another drive, on Home’s ground',
      should: 'link it in its own drive and name that drive beside its list',
      actual: [markup.includes('href="/d2/tasks/page-x"'), markup.includes('Launch Tasks · Launch')],
      expected: [true, true],
    });
  });

  test('the notices: loading, failing, and an empty status', () => {
    assert({
      given: 'rows still loading, a failed load, and no completed rows',
      should: 'say so in place of rows, offering Try again on failure and naming the empty status',
      actual: {
        loading: html({ state: { kind: 'loading' } }).includes('Loading tasks…'),
        failed: html({ state: { kind: 'error', retry: noop } }).includes('Could not load tasks'),
        empty: html({
          status: 'completed',
          state: { kind: 'ready', sections: groundSections([], '2026-10-12') },
        }).includes('No completed tasks in this view.'),
      },
      expected: { loading: true, failed: true, empty: true },
    });
  });
});
