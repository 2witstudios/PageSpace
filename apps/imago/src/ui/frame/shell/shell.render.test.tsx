import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { paneLayout, stageFor, type ListSection } from '../stage/stage';
import { renderShell } from './shell.render';

const markup = (pathname: string, collapsedSections: readonly ListSection[] = [], hydrated = false): string => {
  const stage = stageFor(pathname);
  return renderToString(
    renderShell({
      stage,
      hydrated,
      layout: paneLayout(stage, { collapsedSections }),
      rail: h('p', null, 'rail'),
      list: h('p', null, 'list'),
      object: h('p', null, 'object'),
      chat: h('p', null, 'chat'),
    }),
  );
};

describe('renderShell()', () => {
  test('every slot on every stage', () => {
    const html = markup('/drive-1');
    assert({
      given: 'the drive chat, where neither the list nor the object is open',
      should: 'still mount the rail and all three panes',
      actual: [
        html.includes('aria-label="Primary"'),
        html.includes('data-slot="rail"'),
        html.includes('data-slot="list"'),
        html.includes('data-slot="object"'),
        html.includes('data-slot="chat"'),
        (html.match(/pane-motion/g) ?? []).length,
      ],
      expected: [true, true, true, true, true, 3],
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
    const order = ['data-slot="rail"', 'data-slot="list"', 'data-slot="object"', 'data-slot="chat"'].map((slot) =>
      html.indexOf(slot),
    );
    assert({
      given: 'stage 3',
      should: 'lay out rail, list, object, chat from left to right',
      actual: order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])),
      expected: true,
    });
  });

  test('the stage on the frame', () => {
    assert({
      given: 'stages from the URL and the collapsed sections',
      should: 'name the section, list state and open object as data attributes',
      actual: [
        /data-section="chat" data-list="closed" data-list-hidden="false"/.test(markup('/drive-1')),
        markup('/drive-1').includes('data-object='),
        /data-section="files" data-list="tree" data-list-hidden="false" data-object="page"/.test(
          markup('/drive-1/files/page-1'),
        ),
        /data-list="closed" data-list-hidden="true" data-object="page"/.test(markup('/drive-1/files/page-1', ['files'])),
        markup('/dm/conversation-1').includes('data-object="conversation"'),
        markup('/account').includes('data-object="account"'),
      ],
      expected: [true, false, true, true, true, true],
    });
  });

  test('closed panes', () => {
    const html = markup('/drive-1');
    assert({
      given: 'the drive chat',
      should: 'mark the closed list and object panes inert and aria-hidden, the chat reachable',
      actual: (html.match(/inert=""/g) ?? []).length,
      expected: 2,
    });
  });

  test('the frame', () => {
    assert({
      given: 'the shell',
      should: 'fill the viewport rather than float in it',
      actual: markup('/drive-1').includes('flex h-screen w-full overflow-hidden'),
      expected: true,
    });
  });
});
