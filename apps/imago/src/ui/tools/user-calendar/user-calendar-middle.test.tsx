// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { useCalendarFilterStore } from '@/retained/stores/useCalendarFilterStore';
import { UserCalendarMiddle } from './user-calendar-middle';

const spies = vi.hoisted(() => ({
  embedded: [] as Array<Record<string, unknown>>,
  update: vi.fn(),
}));

vi.mock('@/retained/components/calendar/CalendarView', () => ({
  CalendarView: (props: { embedded: Record<string, unknown>; context: string }) => {
    spies.embedded.push(props.embedded);
    return null;
  },
}));
vi.mock('../calendar/use-calendar-state', () => ({
  useCalendarState: () => ({
    state: { view: 'week', date: new Date(2026, 9, 12), eventId: null, compose: null },
    update: spies.update,
  }),
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (selector: (store: unknown) => unknown) =>
    selector({ drives: [{ id: 'd1', name: 'Studio' }], fetchDrives: vi.fn() }),
}));

afterEach(() => {
  unmountAll();
  spies.embedded.length = 0;
  spies.update.mockReset();
  useCalendarFilterStore.setState({ hiddenCalendars: [], hiddenEventTypes: [], showTasks: true });
});

const pressButton = (root: HTMLElement, text: string) =>
  click(Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement);

describe('UserCalendarMiddle (C-Account-Calendar)', () => {
  test('draws the toolbar and an embedded grid with tasks shown, and no chip row', () => {
    const root = mount(<UserCalendarMiddle />);
    const last = spies.embedded.at(-1)!;
    assert({
      given: 'the user calendar opened with the default filters',
      should: 'hand the grid its embedded state with tasks shown, leaving the filters to the Calendar pane',
      actual: {
        chips: root.querySelector('[role="group"][aria-label="Calendars"]'),
        tasks: last.showTasks,
        view: last.viewMode,
        toolbar: root.querySelector('[role="toolbar"]')?.getAttribute('aria-label'),
      },
      expected: { chips: null, tasks: true, view: 'week', toolbar: 'Calendar' },
    });
  });

  test('the grid follows the pane’s Tasks filter, and its own toggle writes it back', () => {
    mount(<UserCalendarMiddle />);
    act(() => useCalendarFilterStore.getState().toggleTasks());
    const hidden = spies.embedded.at(-1)!;
    act(() => (hidden.onShowTasksChange as (shown: boolean) => void)(true));
    assert({
      given: 'Tasks unchecked in the pane, then the grid asking to show tasks again',
      should: 'hand the grid tasks hidden, then show them in the shared filter store',
      actual: [hidden.showTasks, useCalendarFilterStore.getState().showTasks],
      expected: [false, true],
    });
  });

  test('New event asks the URL for a composing event', () => {
    const root = mount(<UserCalendarMiddle />);
    pressButton(root, 'New event');
    assert({
      given: 'the New event button',
      should: 'write compose=1 into the URL',
      actual: spies.update.mock.calls,
      expected: [[{ compose: '1' }]],
    });
  });
});
