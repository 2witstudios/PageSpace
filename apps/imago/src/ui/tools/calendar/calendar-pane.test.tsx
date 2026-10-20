// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { useCalendarFilterStore } from '@/retained/stores/useCalendarFilterStore';
import { CalendarPane, syncedLabel } from './calendar-pane';

const googleStatus = {
  connected: true,
  connection: { googleEmail: 'jono@studio.example', lastSyncAt: new Date(Date.now() - 4 * 60_000).toISOString() },
};

vi.mock('swr', () => ({
  default: (key: string | null) => ({ data: key === null ? undefined : googleStatus, error: undefined }),
}));
vi.mock('./use-calendar-state', () => ({
  useCalendarState: () => ({ state: { view: 'week', date: new Date(2026, 9, 12), eventId: null, compose: false }, update: vi.fn() }),
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (selector: (store: unknown) => unknown) =>
    selector({ drives: [{ id: 'drv_1', name: 'Studio' }, { id: 'drv_2', name: 'Ops' }], fetchDrives: () => undefined }),
}));

const setMode = (mode: 'cloud' | 'onprem') => {
  process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = mode;
};

beforeEach(() => {
  setMode('cloud');
  useCalendarFilterStore.setState({ hiddenCalendars: [], hiddenEventTypes: [], showTasks: true });
});
afterEach(() => {
  unmountAll();
  delete process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
});

const render = () => mount(<CalendarPane driveId="drv_1" close={null} />);

describe('CalendarPane (C-Drive-Calendar)', () => {
  test('the head, the mini month and both groups', () => {
    const root = render();
    const text = root.textContent ?? '';
    assert({
      given: 'a drive calendar',
      should: 'show the Calendar head with an Event button, October 2026, CALENDARS and EVENT TYPES',
      actual: [
        root.querySelector('section')?.getAttribute('aria-label'),
        root.querySelector('header')?.textContent?.includes('Event'),
        text.includes('October 2026'),
        text.includes('CALENDARS'),
        text.includes('EVENT TYPES'),
      ],
      expected: ['Calendars', true, true, true, true],
    });
  });

  test('the six event types, in the board’s order', () => {
    const labels = Array.from(render().querySelectorAll('ul')[2]?.querySelectorAll('li') ?? []).map((li) => li.textContent);
    assert({
      given: 'the event types legend',
      should: 'list Default, Meeting, Deadline, Focus, Personal and Travel',
      actual: labels,
      expected: ['Default', 'Meeting', 'Deadline', 'Focus', 'Personal', 'Travel'],
    });
  });

  test('a connected Google calendar shows its email and last sync', () => {
    const text = render().textContent ?? '';
    assert({
      given: 'a connected Google calendar on a cloud deployment',
      should: 'show Google · email with the sync time',
      actual: [text.includes('Google · jono@studio.example'), text.includes('synced 4 min ago')],
      expected: [true, true],
    });
  });

  test('on-prem hides the Google row entirely', () => {
    setMode('onprem');
    const text = render().textContent ?? '';
    assert({
      given: 'an on-prem deployment',
      should: 'leave the Google row out, with no sign of the connection',
      actual: text.includes('Google'),
      expected: false,
    });
  });

  test('sync labels', () => {
    const now = new Date('2026-10-12T10:20:00Z');
    assert({
      given: 'syncs a minute ago, two hours ago and never',
      should: 'read as just now, hours, and not synced',
      actual: [
        syncedLabel(new Date('2026-10-12T10:19:30Z').toISOString(), now),
        syncedLabel(new Date('2026-10-12T08:20:00Z').toISOString(), now),
        syncedLabel(null, now),
      ],
      expected: ['synced just now', 'synced 2 hr ago', 'not synced yet'],
    });
  });

  test('on Home, every calendar the grid shows', () => {
    const root = mount(<CalendarPane driveId="drv_1" allDrives close={null} />);
    const calendars = Array.from(root.querySelectorAll('ul')[0]?.querySelectorAll('li') ?? []).map((li) => li.textContent);
    assert({
      given: 'Home, the dashboard, whose grid reads every drive',
      should: 'list Personal and each drive before Google, as the grid’s chips do',
      actual: calendars.slice(0, 3),
      expected: ['Personal', 'Studio', 'Ops'],
    });
  });

  test('the pane is the calendar’s filter (classic’s calendar sidebar)', () => {
    const root = render();
    const show = Array.from(root.querySelectorAll('ul')[1]?.querySelectorAll('[role="checkbox"]') ?? []);
    assert({
      given: 'a drive calendar with the default filters',
      should: 'offer User events, Agent events and Tasks as checked filters',
      actual: show.map((box) => [box.textContent, box.getAttribute('aria-checked')]),
      expected: [
        ['User events', 'true'],
        ['Agent events', 'true'],
        ['Tasks', 'true'],
      ],
    });
  });

  test('a filter writes the shared filter store the grid reads', () => {
    const root = render();
    const boxes = Array.from(root.querySelectorAll('ul')[1]?.querySelectorAll<HTMLButtonElement>('[role="checkbox"]') ?? []);
    boxes.slice(1).forEach((box) => click(box));
    const state = useCalendarFilterStore.getState();
    assert({
      given: 'Agent events and Tasks unchecked in the pane',
      should: 'hide agent events and tasks for the grid',
      actual: [state.hiddenEventTypes, state.showTasks],
      expected: [['agent'], false],
    });
  });

  test('on Home, each calendar shows or hides', () => {
    const root = mount(<CalendarPane driveId="drv_1" allDrives close={null} />);
    const studio = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')).find((box) => box.textContent === 'Studio');
    if (studio) click(studio);
    const hideAll = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Show all' || button.textContent === 'Hide all');
    assert({
      given: 'the Studio calendar unchecked on Home',
      should: 'hide that drive’s calendar for the grid and offer Show all',
      actual: [useCalendarFilterStore.getState().hiddenCalendars, hideAll?.textContent],
      expected: [['drv_1'], 'Show all'],
    });
  });

  test('a drive’s own calendar is not a filter', () => {
    const root = render();
    assert({
      given: 'a single drive’s calendar',
      should: 'list the drive without a checkbox, since there is nothing else to show',
      actual: root.querySelectorAll('ul')[0]?.querySelector('[role="checkbox"]') ?? null,
      expected: null,
    });
  });
});
