// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';

const viewport = vi.hoisted(() => ({ phone: false }));
vi.mock('../viewport/use-viewport-tier', () => ({ usePhone: () => viewport.phone }));

const { AskPill, ClosePage, CloseImago, CloseSidebar, CollapseImago, ShowSidebar } = await import('./controls');

afterEach(() => {
  unmountAll();
  viewport.phone = false;
});

const controls = () =>
  mount(
    h(
      'div',
      null,
      h(CloseSidebar, { section: 'files' }),
      h(ShowSidebar, { section: 'files' }),
      h(CollapseImago),
      h(CloseImago),
      h(AskPill),
      h(ClosePage, { href: '/d1/files' }),
    ),
  );

const names = (root: HTMLElement): (string | null)[] =>
  [...root.querySelectorAll('button, a')].map((control) => control.getAttribute('aria-label') ?? control.textContent);

describe('column controls on a phone', () => {
  test('the sidebar and Imago controls render nothing; Close page stays', () => {
    const desktop = names(controls());
    unmountAll();
    viewport.phone = true;
    const phone = names(controls());
    assert({
      given: 'every column control on desktop and on a phone',
      should: 'keep only Close page on the phone',
      actual: [desktop, phone],
      expected: [['Close sidebar', 'Show sidebar', 'Collapse Imago', 'Close Imago', 'Ask', 'Close page'], ['Close page']],
    });
  });
});
