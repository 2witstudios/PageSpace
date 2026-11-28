// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { UserCalendarToolbar } from './user-calendar-toolbar';

afterEach(unmountAll);

const date = new Date(2026, 9, 12);

describe('UserCalendarToolbar (C-Account-Calendar strip)', () => {
  test('the range, the navigation, Today, the View group and New event', () => {
    const root = mount(
      <UserCalendarToolbar view="week" date={date} onStep={vi.fn()} onToday={vi.fn()} onView={vi.fn()} onNewEvent={vi.fn()} />,
    );
    const labels = Array.from(root.querySelectorAll('button')).map((button) => button.getAttribute('aria-label') ?? button.textContent);
    assert({
      given: 'the week view of the user calendar',
      should: 'show the range, Previous week, Next week, Today, Month/Week/Day/Agenda and New event',
      actual: [root.querySelector('[role="toolbar"]')?.getAttribute('aria-label'), root.textContent?.includes('Oct 12 – 18, 2026'), labels],
      expected: [
        'Calendar',
        true,
        ['Previous week', 'Next week', 'Today', 'Month', 'Week', 'Day', 'Agenda', 'New event'],
      ],
    });
  });

  test('presses only the current view', () => {
    const root = mount(
      <UserCalendarToolbar view="week" date={date} onStep={vi.fn()} onToday={vi.fn()} onView={vi.fn()} onNewEvent={vi.fn()} />,
    );
    assert({
      given: 'the week view',
      should: 'press only Week',
      actual: Array.from(root.querySelectorAll('[aria-pressed="true"]')).map((button) => button.textContent),
      expected: ['Week'],
    });
  });

  test('stepping, today, switching the view and New event', () => {
    const onStep = vi.fn();
    const onToday = vi.fn();
    const onView = vi.fn();
    const onNewEvent = vi.fn();
    const root = mount(
      <UserCalendarToolbar view="week" date={date} onStep={onStep} onToday={onToday} onView={onView} onNewEvent={onNewEvent} />,
    );
    const byText = (text: string) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement;
    click(root.querySelector<HTMLButtonElement>('[aria-label="Next week"]') as HTMLButtonElement);
    click(root.querySelector<HTMLButtonElement>('[aria-label="Previous week"]') as HTMLButtonElement);
    click(byText('Today'));
    click(byText('Month'));
    click(byText('New event'));
    assert({
      given: 'clicks on Next, Previous, Today, Month and New event',
      should: 'step a week each way, go to today, choose the month view and start an event',
      actual: [onStep.mock.calls, onToday.mock.calls.length, onView.mock.calls, onNewEvent.mock.calls.length],
      expected: [[[1], [-1]], 1, [['month']], 1],
    });
  });
});
