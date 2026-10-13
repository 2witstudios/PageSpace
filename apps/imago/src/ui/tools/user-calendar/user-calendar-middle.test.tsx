// @vitest-environment jsdom
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
  useCalendarFilterStore.setState({ hiddenCalendars: [], hiddenEventTypes: [] });
});

const pressButton = (root: HTMLElement, text: string) =>
  click(Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement);

describe('UserCalendarMiddle (C-Account-Calendar)', () => {
  test('draws the toolbar and chips for the user calendars and an embedded grid with tasks shown', () => {
    const root = mount(<UserCalendarMiddle />);
    const last = spies.embedded.at(-1)!;
    assert({
      given: 'the user calendar opened with the default filters',
      should: 'show the Personal and Studio chips and hand the grid its embedded state with tasks shown',
      actual: {
        chips: Array.from(root.querySelectorAll('[role="group"][aria-label="Calendars"] button')).map((b) => b.textContent),
        tasks: last.showTasks,
        view: last.viewMode,
        toolbar: root.querySelector('[role="toolbar"]')?.getAttribute('aria-label'),
      },
      expected: { chips: ['Personal', 'Studio'], tasks: true, view: 'week', toolbar: 'Calendar' },
    });
  });

  test('Show tasks and the calendar chips change what the grid is given', () => {
    const root = mount(<UserCalendarMiddle />);
    pressButton(root, 'Show tasks');
    pressButton(root, 'Studio');
    const last = spies.embedded.at(-1)!;
    assert({
      given: 'Show tasks and the Studio chip pressed',
      should: 'hide tasks in the grid and hide the Studio calendar in the shared filter store',
      actual: [last.showTasks, useCalendarFilterStore.getState().hiddenCalendars],
      expected: [false, ['d1']],
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
