import Link from 'next/link';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { overflowItems, railItems, settingsItem } from './rail-items';
import { renderRail, type RailRenderProps } from './rail.render';

const props = (overrides: Partial<RailRenderProps> = {}): RailRenderProps => ({
  items: railItems('drive-1'),
  settings: settingsItem('drive-1'),
  activeId: 'files',
  activeAt: 'page',
  unread: { messages: 4 },
  overflow: overflowItems('drive-1'),
  moreOpen: false,
  onMoreToggle: () => {},
  brand: <span data-brand="">Alpha</span>,
  footer: <button type="button">Sign out</button>,
  ...overrides,
});

const markup = (overrides: Partial<RailRenderProps> = {}): string =>
  renderToStaticMarkup(renderRail(props(overrides)));

/** Accessible names of the rail's controls, in document order. */
const names = (html: string): string[] =>
  [...html.matchAll(/<(?:a|button|summary)\b[^>]*?aria-label="([^"]+)"/g)].map((match) => match[1] ?? '');

describe('renderRail()', () => {
  test('the destinations, in order', () => {
    assert({
      given: 'the rail for a drive',
      should: 'list Chat, Files, Messages (with its count), Tasks, the ⋯ overflow below Tasks, and Settings pinned at the foot',
      actual: names(markup()),
      expected: ['Chat', 'Files', 'Messages, 4 unread', 'Tasks', 'More', 'Settings'],
    });
  });

  test('one active item', () => {
    const page = markup();
    const section = markup({ activeAt: 'section' });
    assert({
      given: 'Files active at its own URL, then at a page inside it',
      should: 'mark only Files: as the current page, then as the current section',
      actual: [
        page.match(/aria-current="[^"]+"/g),
        /aria-label="Files" aria-current="page"/.test(page),
        section.match(/aria-current="[^"]+"/g),
      ],
      expected: [['aria-current="page"'], true, ['aria-current="true"']],
    });
  });

  test('the footer', () => {
    const html = markup();
    assert({
      given: 'a footer control (the avatar menu)',
      should: 'render it in the pinned list after Settings',
      actual: html.indexOf('Sign out') > html.indexOf('aria-label="Settings"'),
      expected: true,
    });
  });

  test('the overflow, closed', () => {
    const html = markup();
    assert({
      given: 'the overflow closed',
      should: 'render a disclosure named More without the open attribute',
      actual: [/<details[^>]*>/.exec(html)?.[0].includes(' open'), /<summary[^>]*aria-label="More"/.test(html)],
      expected: [false, true],
    });
  });

  test('the overflow, open', () => {
    const html = markup({ moreOpen: true });
    const links = [...html.matchAll(/<a href="(\/dashboard\/[^"]+)"[^>]*>.*?<\/svg>([^<]+)<\/a>/g)].map((match) => [
      match[2],
      match[1],
    ]);
    assert({
      given: 'the overflow open',
      should: 'list Calendar, Agents, Connections, Activity and Trash as links into classic for this drive',
      actual: [/<details[^>]* open=""/.test(html), links],
      expected: [
        true,
        [
          ['Calendar', '/dashboard/drive-1/calendar'],
          ['Agents', '/dashboard/drive-1/agents'],
          ['Connections', '/dashboard/drive-1/settings/integrations'],
          ['Activity', '/dashboard/drive-1/activity'],
          ['Trash', '/dashboard/drive-1/trash'],
        ],
      ],
    });
  });

  test('classic links leave imago’s router', () => {
    const tree = renderRail(props({ moreOpen: true }));
    const nextLinkToClassic = findElement<{ href: string }>(
      tree,
      (element) => element.type === Link && String(element.props.href).startsWith('/dashboard/'),
    );
    const anchor = findElement<{ href: string }>(tree, (element) => element.type === 'a');
    assert({
      given: 'the overflow’s classic deep links',
      should: 'be plain anchors, so Next does not prefix imago’s basePath',
      actual: [nextLinkToClassic, anchor?.props.href],
      expected: [undefined, '/dashboard/drive-1/calendar'],
    });
  });

  test('toggling the overflow', () => {
    const onMoreToggle = vi.fn();
    const details = findElement<{ onToggle: (event: { currentTarget: { open: boolean } }) => void }>(
      renderRail(props({ onMoreToggle })),
      (element) => element.type === 'details',
    );
    details?.props.onToggle({ currentTarget: { open: true } });
    assert({
      given: 'the browser toggling the disclosure open',
      should: 'report the new state to the container',
      actual: onMoreToggle.mock.calls,
      expected: [[true]],
    });
  });

  test('no drive', () => {
    const html = markup({ items: railItems(null), settings: settingsItem(null), overflow: null, activeId: null });
    assert({
      given: 'no drive to link to',
      should: 'render every destination and More as disabled buttons, with no links',
      actual: [html.includes('<a '), html.includes('<details'), (html.match(/disabled=""/g) ?? []).length],
      expected: [false, false, 6],
    });
  });

  test('the brand', () => {
    const html = markup();
    assert({
      given: 'a drive switcher',
      should: 'render it above the sections',
      actual: [html.indexOf('data-brand') >= 0, html.indexOf('data-brand') < html.indexOf('aria-label="Chat"')],
      expected: [true, true],
    });

    assert({
      given: 'no drive switcher',
      should: 'render no wrapper for it',
      actual: markup({ brand: null }).includes('mb-rail-y'),
      expected: false,
    });
  });
});
