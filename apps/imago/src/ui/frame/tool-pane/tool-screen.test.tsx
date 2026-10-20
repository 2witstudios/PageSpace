// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { toolScreenHref, useToolScreen } from './tool-screen';

const nav = vi.hoisted(() => ({ pathname: '/d1/calendar', push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => nav.pathname,
}));

afterEach(() => {
  unmountAll();
  nav.pathname = '/d1/calendar';
  nav.push.mockReset();
  nav.replace.mockReset();
});

function Opener() {
  const screen = useToolScreen('d1', 'calendar');
  return (
    <button type="button" data-on-screen={String(screen.onScreen)} onClick={() => screen.open('?date=2026-10-20')}>
      Open
    </button>
  );
}

describe('toolScreenHref()', () => {
  test('each tool’s screen', () => {
    assert({
      given: 'a single-screen tool, Members, a query, and a drive id that needs escaping',
      should: 'address /view, Members’ /all, keep the query and escape the drive',
      actual: [
        toolScreenHref('d1', 'calendar'),
        toolScreenHref('d1', 'members'),
        toolScreenHref('d1', 'workflows', '?id=w1'),
        toolScreenHref('a b', 'trash'),
      ],
      expected: ['/d1/calendar/view', '/d1/members/all', '/d1/workflows/view?id=w1', '/a%20b/trash/view'],
    });
  });
});

describe('useToolScreen()', () => {
  test('from the pane alone', () => {
    const root = mount(<Opener />);
    const button = root.querySelector('button')!;
    click(button);
    assert({
      given: 'the tool’s pane beside the chat, with no screen open',
      should: 'report it off screen and push the screen with the query, so Back returns to the pane',
      actual: [button.dataset.onScreen, nav.push.mock.calls[0]?.[0], nav.replace.mock.calls.length],
      expected: ['false', '/d1/calendar/view?date=2026-10-20', 0],
    });
  });

  test('on the screen', () => {
    nav.pathname = '/d1/calendar/view';
    const root = mount(<Opener />);
    const button = root.querySelector('button')!;
    click(button);
    assert({
      given: 'the tool’s screen already open',
      should: 'report it on screen and replace the query in place',
      actual: [button.dataset.onScreen, nav.replace.mock.calls[0]?.[0], nav.push.mock.calls.length],
      expected: ['true', '/d1/calendar/view?date=2026-10-20', 0],
    });
  });
});
