import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { columnsFor } from '../stage/columns';
import { isHideableSection, paneLayout, stageFor, type HideableSection } from '../stage/stage';
import { renderShell } from './shell.render';

type Imago = { readonly imagoCollapsed?: boolean; readonly imagoClosed?: boolean };

const markup = (
  pathname: string,
  collapsedSections: readonly HideableSection[] = [],
  hydrated = false,
  imago: Imago = {},
): string => {
  const stage = stageFor(pathname);
  const columns = columnsFor(stage, {
    paneCollapsed: isHideableSection(stage.section) && collapsedSections.includes(stage.section),
    imagoCollapsed: imago.imagoCollapsed ?? false,
    imagoClosed: imago.imagoClosed ?? false,
  });
  return renderToString(
    renderShell({
      stage,
      hydrated,
      layout: paneLayout(stage, { collapsedSections }),
      columns,
      rail: h('p', null, 'rail'),
      tabBar: h('p', { 'data-tab-bar': '' }, 'tabs'),
      list: h('p', null, 'list'),
      object: h('p', null, 'object'),
      chat: h('p', null, 'chat'),
      empty: h('p', null, 'empty'),
      palette: h('p', null, 'palette'),
    }),
  );
};

describe('renderShell()', () => {
  test('every slot on every stage', () => {
    const html = markup('/drive-1');
    assert({
      given: 'the drive chat, where neither the page nor the empty middle is open',
      should: 'still mount the spine, the stage sheet and all four panes, animating only the fixed-width ones',
      actual: [
        html.includes('aria-label="Sections"'),
        html.includes('data-slot="rail"'),
        html.includes('data-slot="stage"'),
        html.includes('data-slot="list"'),
        html.includes('data-slot="object"'),
        html.includes('data-slot="chat"'),
        html.includes('data-slot="empty"'),
        (html.match(/pane-motion/g) ?? []).length,
      ],
      expected: [true, true, true, true, true, true, true, 3],
    });
  });

  test('whether the client has hydrated', () => {
    assert({
      given: 'the server render, then the hydrated client',
      should: 'mark the frame data-hydrated only once hydrated',
      actual: [markup('/drive-1').includes('data-hydrated'), markup('/drive-1', [], true).includes('data-hydrated=""')],
      expected: [false, true],
    });
  });

  test('the slots in frame order', () => {
    const html = markup('/drive-1/files/page-1');
    const order = [
      'data-slot="rail"',
      'data-slot="stage"',
      'data-tab-bar',
      'data-slot="list"',
      'data-slot="object"',
      'data-slot="chat"',
      'data-slot="empty"',
    ].map((slot) => html.indexOf(slot));
    assert({
      given: 'stage 3',
      should: 'lay out the spine, then in the stage sheet the tab bar over list, page, Imago and the empty middle',
      actual: order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])),
      expected: true,
    });
  });

  test('the stage on the frame', () => {
    assert({
      given: 'stages from the URL and the collapsed sections',
      should: 'name the section, list state and open object as data attributes',
      actual: [
        /data-section="chat" data-list="list" data-list-hidden="false"/.test(markup('/drive-1')),
        /data-section="chat" data-list="closed" data-list-hidden="true"/.test(markup('/drive-1', ['chat'])),
        markup('/drive-1').includes('data-object='),
        /data-section="files" data-list="tree" data-list-hidden="false" data-object="page"/.test(
          markup('/drive-1/files/page-1'),
        ),
        /data-list="closed" data-list-hidden="true" data-object="page"/.test(markup('/drive-1/files/page-1', ['files'])),
        markup('/dm/conversation-1').includes('data-object="conversation"'),
        markup('/account').includes('data-object="account"'),
        /data-section="account" data-list="tree"/.test(markup('/account')),
      ],
      expected: [true, true, false, true, true, true, true, true],
    });
  });

  test('where Imago is', () => {
    const imagoOf = (html: string): string | undefined => /data-imago="([^"]+)"/.exec(html)?.[1];
    assert({
      given: 'the drive chat, a page, a page with Imago collapsed, and the drive chat with Imago closed',
      should: 'name Imago’s place on the frame: ground, docked, collapsed, none',
      actual: [
        imagoOf(markup('/drive-1')),
        imagoOf(markup('/drive-1/files/page-1')),
        imagoOf(markup('/drive-1/files/page-1', [], false, { imagoCollapsed: true })),
        imagoOf(markup('/drive-1', [], false, { imagoClosed: true })),
      ],
      expected: ['ground', 'docked', 'collapsed', 'none'],
    });
  });

  test('closed panes', () => {
    assert({
      given: 'the drive chat beside its history, then with the history hidden, then with Imago closed',
      should: 'mark only the closed panes inert: the page and the empty middle, then the list too; closing Imago swaps it for the empty middle',
      actual: [
        (markup('/drive-1').match(/inert=""/g) ?? []).length,
        (markup('/drive-1', ['chat']).match(/inert=""/g) ?? []).length,
        /data-slot="chat"[^>]*inert=""|inert=""[^>]*data-slot="chat"/.test(markup('/drive-1', [], false, { imagoClosed: true })),
        /data-slot="empty"[^>]*inert=""|inert=""[^>]*data-slot="empty"/.test(markup('/drive-1', [], false, { imagoClosed: true })),
      ],
      expected: [2, 3, true, false],
    });
  });

  test('the frame', () => {
    assert({
      given: 'the shell',
      should: 'fill the viewport on the spine’s blue rather than float in it',
      actual: markup('/drive-1').includes('class="flex h-screen w-full overflow-hidden bg-spine"'),
      expected: true,
    });
  });
});
