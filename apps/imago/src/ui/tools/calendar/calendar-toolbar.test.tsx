// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { CalendarToolbar } from './calendar-toolbar';

afterEach(unmountAll);

const date = new Date(2026, 9, 14);

describe('CalendarToolbar (C-Drive-Calendar week strip)', () => {
  test('the range, the navigation and the View group', () => {
    const root = mount(
      <CalendarToolbar view="week" date={date} onStep={vi.fn()} onToday={vi.fn()} onView={vi.fn()} />,
    );
    const labels = Array.from(root.querySelectorAll('button')).map((button) => button.getAttribute('aria-label') ?? button.textContent);
    assert({
      given: 'the week view',
      should: 'show the range, Previous week, Next week, Today and Day/Week/Month/Agenda',
      actual: [root.querySelector('h2')?.textContent, labels],
      expected: ['Oct 12 – 18, 2026', ['Previous week', 'Next week', 'Today', 'Day', 'Week', 'Month', 'Agenda']],
    });
  });

  test('the pressed view', () => {
    const root = mount(
      <CalendarToolbar view="week" date={date} onStep={vi.fn()} onToday={vi.fn()} onView={vi.fn()} />,
    );
    const pressed = Array.from(root.querySelectorAll('[aria-pressed="true"]')).map((button) => button.textContent);
    assert({
      given: 'the week view',
      should: 'press only Week',
      actual: pressed,
      expected: ['Week'],
    });
  });

  test('stepping, today and switching the view', () => {
    const onStep = vi.fn();
    const onToday = vi.fn();
    const onView = vi.fn();
    const root = mount(<CalendarToolbar view="week" date={date} onStep={onStep} onToday={onToday} onView={onView} />);
    click(root.querySelector<HTMLButtonElement>('[aria-label="Next week"]') as HTMLButtonElement);
    click(root.querySelector<HTMLButtonElement>('[aria-label="Previous week"]') as HTMLButtonElement);
    click(Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Today') as HTMLButtonElement);
    click(Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Month') as HTMLButtonElement);
    assert({
      given: 'clicks on Next, Previous, Today and Month',
      should: 'step a week each way, go to today and choose the month view',
      actual: [onStep.mock.calls, onToday.mock.calls.length, onView.mock.calls],
      expected: [[[1], [-1]], 1, [['month']]],
    });
  });
});
