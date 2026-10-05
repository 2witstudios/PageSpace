// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { citationChipClass } from '../citation-chip/citation-chip-class';
import { proseClasses } from './chat-prose-class';
import { ChatProse } from './chat-prose';

afterEach(() => {
  unmountAll();
});

/** The markup in a detached container, to query like the browser would. */
const dom = (text: string, citationDriveId: string | null = 'd1'): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = renderToString(<ChatProse text={text} streaming={false} citationDriveId={citationDriveId} />);
  return container;
};

describe('ChatProse', () => {
  test('markdown', () => {
    const view = dom('Ship **in October**.\n\n- design\n- build\n\n> quoted');
    assert({
      given: 'markdown with bold text, a list and a quote',
      should: 'render it as prose elements, not as literal markdown',
      actual: [
        view.querySelector('strong')?.textContent,
        [...view.querySelectorAll('ul > li')].map((item) => item.textContent),
        view.querySelector('ul')?.className,
        view.querySelector('blockquote')?.textContent?.trim(),
        view.textContent?.includes('**'),
      ],
      expected: ['in October', ['design', 'build'], proseClasses.ul, 'quoted', false],
    });
  });

  test('raw html is text', () => {
    const view = dom('Look <img src=x onerror=alert(1)> here <script>alert(2)</script> <b>bold</b>');
    assert({
      given: 'a reply carrying raw HTML: an image with a handler, a script and a tag',
      should: 'create no element from it and show it as text',
      actual: [
        view.querySelector('img, script, b'),
        view.querySelector('[onerror]'),
        view.textContent?.includes('<img src=x onerror=alert(1)>'),
        view.textContent?.includes('<script>alert(2)</script>'),
      ],
      expected: [null, null, true, true],
    });
  });

  test('unsafe links', () => {
    const view = dom('[click](javascript:alert(1)) [data](data:text/html,hi) [site](https://example.com/a)');
    const hrefs = [...view.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    const site = view.querySelector('a[href="https://example.com/a"]');
    assert({
      given: 'a javascript: link, a data: link and an https link',
      should: 'link only the https one, opening it in a new tab without an opener',
      actual: [hrefs, site?.getAttribute('target'), site?.getAttribute('rel'), site?.className],
      expected: [['https://example.com/a'], '_blank', 'noopener noreferrer', proseClasses.a],
    });
  });

  test('page citations', () => {
    const view = dom('See @[Roadmap](p1:page) and ask @[Ada](u1:user).');
    const chip = view.querySelector('a[data-citation]');
    assert({
      given: 'a reply citing a page and mentioning a person, in drive d1',
      should: 'render the page as a hairline chip linking to /imago/d1/files/p1 (basePath adds /imago) and the person as plain text',
      actual: [
        chip?.getAttribute('href'),
        chip?.className,
        chip?.textContent,
        chip?.getAttribute('target'),
        view.querySelectorAll('a').length,
        view.textContent?.includes('@Ada'),
      ],
      expected: ['/d1/files/p1', citationChipClass, 'Roadmap', null, 1, true],
    });
  });

  test('a citation with no drive', () => {
    const view = dom('See @[Roadmap](p1:page).', null);
    assert({
      given: 'a page citation where no drive is known',
      should: 'show the chip without a link',
      actual: [view.querySelector('a'), view.querySelector('[data-citation]')?.className, view.querySelector('[data-citation]')?.textContent],
      expected: [null, citationChipClass, 'Roadmap'],
    });
  });

  test('code', () => {
    const view = dom('Use `npm` never.\n\n```ts\nconst a = 1;\n```');
    assert({
      given: 'inline code and a fenced block',
      should: 'render both as plain token-styled code, with no lazy highlighter',
      actual: [
        view.querySelector('p code')?.className,
        view.querySelector('pre')?.className,
        view.querySelector('pre code')?.textContent,
        view.querySelector('template'),
      ],
      expected: [proseClasses.code, proseClasses.pre, 'const a = 1;\n', null],
    });
  });

  test('streaming', async () => {
    const view = dom('Half **bold');
    const live = mount(<ChatProse text="Half **bold" streaming citationDriveId="d1" />);
    await vi.waitFor(async () => {
      await act(async () => {});
      if (live.querySelector('strong') === null) throw new Error('not rendered');
    });
    assert({
      given: 'an unfinished bold span, finished and while streaming',
      should: 'show it as written once finished, and complete the span while streaming so no stray asterisks show',
      actual: [view.textContent?.includes('**'), live.querySelector('strong')?.textContent, live.textContent?.includes('**')],
      expected: [true, 'bold', false],
    });
  });
});
