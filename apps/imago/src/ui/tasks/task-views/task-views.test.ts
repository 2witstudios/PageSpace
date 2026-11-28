import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { groundHeading, taskViews, viewFor } from './task-views';

describe('task views', () => {
  test('each view names the due window the ground filters by', () => {
    assert({
      given: 'the five smart views',
      should: 'list Assigned to me without a window, then Overdue, Due today, This week and Upcoming',
      actual: taskViews.map((view) => [view.label, view.dueDateFilter ?? null]),
      expected: [
        ['Assigned to me', null],
        ['Overdue', 'overdue'],
        ['Due today', 'today'],
        ['This week', 'this_week'],
        ['Upcoming', 'upcoming'],
      ],
    });
  });

  test('the ground heading follows the view picked', () => {
    assert({
      given: 'the assigned view and the overdue view',
      should: 'head the ground Assigned to you, and the overdue one by its own name',
      actual: [groundHeading('assigned'), groundHeading('overdue'), viewFor('overdue').warn],
      expected: ['Assigned to you', 'Overdue', true],
    });
  });
});
