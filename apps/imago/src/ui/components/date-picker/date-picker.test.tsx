// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, unmountAll } from '../../test-support/dom';
import { DatePicker, type DatePickerProps } from './date-picker';

afterEach(unmountAll);

const TODAY = '2026-10-19';

const picker = (props: Partial<DatePickerProps> = {}) => {
  const picks: (string | null)[] = [];
  let done = 0;
  const container = mount(
    <DatePicker
      label="Due date"
      value=""
      today={TODAY}
      pick={(day) => picks.push(day)}
      done={() => {
        done += 1;
      }}
      {...props}
    />,
  );
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.getAttribute('aria-label') === name || entry.textContent?.startsWith(name),
    ) as HTMLButtonElement;
  return { container, picks, button, done: () => done };
};

describe('DatePicker', () => {
  test('the month, today and the chosen day', () => {
    const { container } = picker({ value: '2026-10-23' });
    const grid = container.querySelector('[role="grid"]');
    assert({
      given: 'a picker on October 23 with today the 19th',
      should: 'show October Monday first, mark today, select the 23rd and keep only it in the tab order',
      actual: {
        name: grid?.getAttribute('aria-label'),
        heads: [...container.querySelectorAll('[role="columnheader"]')].map((head) => head.textContent),
        today: container.querySelector('[aria-current="date"]')?.getAttribute('aria-label'),
        selected: container.querySelector('[aria-selected="true"] button')?.getAttribute('aria-label'),
        tabbable: [...container.querySelectorAll('[role="grid"] button[tabindex="0"]')].map((day) => day.textContent),
        clear: container.textContent?.includes('Clear date'),
      },
      expected: {
        name: 'Due date, October 2026',
        heads: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
        today: 'Monday, October 19, 2026',
        selected: 'Friday, October 23, 2026',
        tabbable: ['23'],
        clear: true,
      },
    });
  });

  test('choosing', () => {
    const { picks, button, done } = picker({ value: '2026-10-23' });
    click(button('Tomorrow'));
    click(button('Saturday, October 31, 2026'));
    click(button('Clear date'));
    click(button('Done'));
    assert({
      given: 'Tomorrow, a day in the grid, Clear date and Done pressed',
      should: 'pick each day, then null, then say done',
      actual: { picks, done: done() },
      expected: { picks: ['2026-10-20', '2026-10-31', null], done: 1 },
    });
  });

  test('a window', () => {
    const { button, container } = picker({ min: '2026-10-21', max: '2026-10-30' });
    assert({
      given: 'a picker allowing the 21st to the 30th',
      should: 'disable the quick picks and days outside it, and offer no Clear while nothing is set',
      actual: {
        today: button('Today').disabled,
        nextWeek: button('Next week').disabled,
        twoWeeks: button('In 2 weeks').disabled,
        before: button('Tuesday, October 20, 2026').disabled,
        inside: button('Wednesday, October 21, 2026').disabled,
        clear: container.textContent?.includes('Clear date'),
      },
      expected: { today: true, nextWeek: false, twoWeeks: true, before: true, inside: false, clear: false },
    });
  });

  test('the keyboard and the month buttons', () => {
    const { button, container } = picker({ value: '2026-10-30' });
    const title = () => container.querySelector('[aria-live]')?.textContent;
    press(button('Friday, October 30, 2026'), 'ArrowDown');
    const moved = { focus: document.activeElement?.getAttribute('aria-label'), title: title() };
    click(button('Previous month'));
    click(button('Previous month'));
    const back = { title: title(), tabbable: container.querySelector('[role="grid"] button[tabindex="0"]')?.getAttribute('aria-label') };
    click(button('Next month'));
    assert({
      given: 'ArrowDown from October 30, then the month buttons back twice and forward once',
      should: 'move focus a week into November, page the months, and keep a day of the shown month tabbable',
      actual: { moved, back, forward: title() },
      expected: {
        moved: { focus: 'Friday, November 6, 2026', title: 'November 2026' },
        back: { title: 'September 2026', tabbable: 'Tuesday, September 1, 2026' },
        forward: 'October 2026',
      },
    });
  });

  test('the keyboard at a window’s ends', () => {
    const { button, container } = picker({ value: '2026-10-29', min: '2026-10-21', max: '2026-10-30' });
    const focus = () => document.activeElement?.getAttribute('aria-label');
    const tabbable = () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="grid"] button[tabindex="0"]')].map((day) => [
        day.getAttribute('aria-label'),
        day.disabled,
      ]);
    press(button('Thursday, October 29, 2026'), 'ArrowDown');
    const clamped = { focus: focus(), tabbable: tabbable() };
    press(button('Friday, October 30, 2026'), 'ArrowRight');
    const held = { focus: focus(), tabbable: tabbable() };
    assert({
      given: 'ArrowDown from the 29th past a window ending the 30th, then ArrowRight from the 30th',
      should: 'stop on the last allowed day and stay there, keeping an enabled day tabbable',
      actual: { clamped, held },
      expected: {
        clamped: { focus: 'Friday, October 30, 2026', tabbable: [['Friday, October 30, 2026', false]] },
        held: { focus: 'Friday, October 30, 2026', tabbable: [['Friday, October 30, 2026', false]] },
      },
    });
  });

  test('a first focus outside the window', () => {
    const { container, button } = picker({ min: '2026-10-21', max: '2026-11-10' });
    const tabbable = () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="grid"] button[tabindex="0"]')].map((day) => [
        day.getAttribute('aria-label'),
        day.disabled,
      ]);
    const first = tabbable();
    click(button('Next month'));
    click(button('Next month'));
    click(button('Previous month'));
    const paged = tabbable();
    assert({
      given: 'no value with today before the window, then paging to December and back to November',
      should: 'make the window’s first day tabbable, and keep the tabbable day within the window as the months page',
      actual: { first, paged },
      expected: {
        first: [['Wednesday, October 21, 2026', false]],
        paged: [['Tuesday, November 10, 2026', false]],
      },
    });
  });
});
