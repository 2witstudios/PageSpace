// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { UserCalendarChips, type UserCalendarChipsProps } from './user-calendar-chips';

afterEach(unmountAll);

const base: UserCalendarChipsProps = {
  calendars: [
    { key: 'personal', name: 'Personal', dotClass: 'bg-blue-500', visible: true },
    { key: 'd1', name: 'Studio', dotClass: 'bg-green-500', visible: false },
  ],
  onToggleCalendar: vi.fn(),
  userEventsVisible: true,
  agentEventsVisible: true,
  onToggleUserEvents: vi.fn(),
  onToggleAgentEvents: vi.fn(),
  showTasks: true,
  onToggleTasks: vi.fn(),
};

const pressedNames = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('button[aria-pressed="true"]')).map((button) => button.textContent);

describe('UserCalendarChips (C-Account-Calendar filter row)', () => {
  test('one aria-pressed chip per calendar, then the User events, Agent events and Show tasks toggles', () => {
    const root = mount(<UserCalendarChips {...base} />);
    assert({
      given: 'a personal calendar shown and a drive calendar hidden',
      should: 'press the shown calendar and the two event types and tasks, and leave the hidden calendar unpressed',
      actual: {
        pressed: pressedNames(root),
        all: Array.from(root.querySelectorAll('button[aria-pressed]')).map((button) => button.textContent),
      },
      expected: {
        pressed: ['Personal', 'User events', 'Agent events', 'Show tasks'],
        all: ['Personal', 'Studio', 'User events', 'Agent events', 'Show tasks'],
      },
    });
  });

  test('a press on a chip or a toggle reports it', () => {
    const props = { ...base, onToggleCalendar: vi.fn(), onToggleAgentEvents: vi.fn(), onToggleTasks: vi.fn() };
    const root = mount(<UserCalendarChips {...props} />);
    const byText = (text: string) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement;
    click(byText('Studio'));
    click(byText('Agent events'));
    click(byText('Show tasks'));
    assert({
      given: 'presses on Studio, Agent events and Show tasks',
      should: 'report each one to its handler',
      actual: [props.onToggleCalendar.mock.calls, props.onToggleAgentEvents.mock.calls.length, props.onToggleTasks.mock.calls.length],
      expected: [[['d1']], 1, 1],
    });
  });

  test('a hidden event type and hidden tasks are unpressed', () => {
    const root = mount(<UserCalendarChips {...base} agentEventsVisible={false} showTasks={false} />);
    assert({
      given: 'agent events hidden and tasks hidden',
      should: 'leave Agent events and Show tasks unpressed',
      actual: pressedNames(root),
      expected: ['Personal', 'User events'],
    });
  });
});
