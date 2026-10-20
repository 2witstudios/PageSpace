// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { useCalendarState } from './use-calendar-state';

const nav = vi.hoisted(() => ({ pathname: '/d1/calendar', search: '', push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  unmountAll();
  nav.pathname = '/d1/calendar';
  nav.search = '';
  nav.push.mockReset();
  nav.replace.mockReset();
});

function PickDate() {
  const { update } = useCalendarState();
  return (
    <button type="button" onClick={() => update({ date: '2026-10-21' })}>
      Pick
    </button>
  );
}

describe('useCalendarState() update', () => {
  test('from the Calendar pane alone', () => {
    const root = mount(<PickDate />);
    click(root.querySelector('button')!);
    assert({
      given: 'a date picked while only the Calendar pane is open',
      should: 'push the calendar’s screen on that date, so Back returns to the pane',
      actual: [nav.push.mock.calls[0]?.[0], nav.replace.mock.calls.length],
      expected: ['/d1/calendar/view?date=2026-10-21', 0],
    });
  });

  test('on the calendar’s screen', () => {
    nav.pathname = '/d1/calendar/view';
    nav.search = 'view=week';
    const root = mount(<PickDate />);
    click(root.querySelector('button')!);
    assert({
      given: 'a date picked with the calendar already open',
      should: 'replace the address in place, keeping the rest of the query',
      actual: [nav.replace.mock.calls[0]?.[0], nav.push.mock.calls.length],
      expected: ['/d1/calendar/view?view=week&date=2026-10-21', 0],
    });
  });
});
