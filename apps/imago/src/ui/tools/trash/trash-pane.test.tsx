// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { TrashPane } from './trash-pane';

const nav = vi.hoisted(() => ({ pathname: '/d1/trash', search: '' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  unmountAll();
  nav.pathname = '/d1/trash';
  nav.search = '';
});

const links = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('nav[aria-label="Trash"] a')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]);

describe('TrashPane', () => {
  test('beside the chat, before the trash opens', () => {
    const root = mount(<TrashPane driveId="d1" close={null} />);
    assert({
      given: 'the Trash pane alone',
      should: 'head it Trash and offer everything, pages and files, each opening the trash screen, none current',
      actual: [root.querySelector('header')?.textContent, links(root)],
      expected: [
        'Trash',
        [
          ['Everything in trash', '/d1/trash/view', null],
          ['Pages', '/d1/trash/view?type=pages', null],
          ['Files', '/d1/trash/view?type=files', null],
        ],
      ],
    });
  });

  test('on the trash screen, filtered', () => {
    nav.pathname = '/d1/trash/view';
    nav.search = 'type=files';
    const root = mount(<TrashPane driveId="d1" close={null} />);
    assert({
      given: 'the trash screen open on Files',
      should: 'mark only Files current',
      actual: links(root).map(([, , current]) => current),
      expected: [null, null, 'page'],
    });
  });
});
