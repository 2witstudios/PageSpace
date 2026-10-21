import Link from 'next/link';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { spineDividerClass, spineScrollClass, spineTileClass } from '../rail-button/rail-button-class';
import { activeRailItem, activeRailPlace, moreItems, railItems, secondaryItems, settingsItem } from './rail-items';
import { stageFor } from '../stage/stage';
import { renderRail, type RailRenderProps } from './rail.render';

const props = (overrides: Partial<RailRenderProps> = {}): RailRenderProps => ({
  items: railItems('drive-1'),
  tools: secondaryItems('drive-1'),
  more: moreItems('drive-1'),
  settings: settingsItem('drive-1'),
  activeId: 'files',
  activeAt: 'page',
  unread: { messages: 4 },
  bell: <button type="button" aria-label="Notifications">Bell</button>,
  onSearch: () => {},
  brand: <span data-brand="">Alpha</span>,
  footer: <button type="button">Sign out</button>,
  ...overrides,
});

const markup = (overrides: Partial<RailRenderProps> = {}): string =>
  renderToStaticMarkup(renderRail(props(overrides)));

/** Accessible names of the rail's controls, in document order. */
const names = (html: string): string[] =>
  [...html.matchAll(/<(?:a|button|summary)\b[^>]*?aria-label="([^"]+)"/g)].map((match) => match[1] ?? '');

const tools = ['Calendar', 'Console'];

describe('renderRail()', () => {
  test('Calendar’s current-page announcement follows its destination', () => {
    assert({
      given: 'Calendar with its screen open, then its sidebar alone',
      should: 'announce Calendar as the current page only at its linked destination',
      actual: ['/drive-1/calendar/view', '/drive-1/calendar'].map((path) => {
        const stage = stageFor(path);
        return markup({ activeId: activeRailItem(stage), activeAt: activeRailPlace(stage) }).match(/aria-current="[^"]+"/g);
      }),
      expected: [['aria-current="page"'], ['aria-current="true"']],
    });
  });

  test('the destinations, in order', () => {
    assert({
      given: 'the spine for a drive',
      should: 'list Search, Chat, Files, Messages (with its count), Tasks, Calendar and Agents, More, the bell and Drive settings',
      actual: names(markup()),
      expected: ['Search', 'Home', 'Files', 'Messages, 4 unread', 'Tasks', ...tools, 'More', 'Notifications', 'Drive settings'],
    });
  });

  test('section tiles and tool tiles', () => {
    const html = markup({ activeId: null });
    const classOf = (name: string): string | undefined =>
      new RegExp(`class="([^"]+)"[^>]*aria-label="${name}"`).exec(html)?.[1];
    assert({
      given: 'nothing active',
      should: 'draw the four sections as 48px tiles and Search, the tools and Drive settings as small ones',
      actual: [
        ['Home', 'Files', 'Tasks'].map(classOf),
        ['Calendar', 'Console', 'Drive settings'].map(classOf),
        classOf('Search'),
      ],
      expected: [
        Array(3).fill(spineTileClass('primary', false)),
        Array(3).fill(spineTileClass('small', false)),
        `${spineTileClass('small', false)} mb-2`,
      ],
    });
  });

  test('the divider', () => {
    const html = markup();
    const divider = html.indexOf(`<span class="${spineDividerClass}" aria-hidden="true"></span>`);
    assert({
      given: 'the spine',
      should: 'draw one decorative rule between Tasks and the drive tools',
      actual: [
        (html.match(new RegExp(spineDividerClass, 'g')) ?? []).length,
        divider > html.indexOf('aria-label="Tasks"'),
        divider < html.indexOf('aria-label="Calendar"'),
      ],
      expected: [1, true, true],
    });
  });

  test('the drive tools', () => {
    const tree = renderRail(props());
    const hrefs = tools.map(
      (name) =>
        findElement<{ href: string; 'aria-label': string }>(
          tree,
          (element) => element.type === Link && (element.props as { 'aria-label'?: string })['aria-label'] === name,
        )?.props.href,
    );
    assert({
      given: 'the tools under the divider',
      should: 'link each into the drive through the Imago router',
      actual: hrefs,
      expected: ['/drive-1/calendar/view', '/drive-1/agents'],
    });
  });

  test('the More menu links the housekeeping tools', () => {
    const html = markup();
    assert({
      given: 'the More menu at the foot',
      should: 'link Workflows, Activity, Members and Trash into the drive, above the bell',
      actual: [
        ['/drive-1/workflows', '/drive-1/activity', '/drive-1/members', '/drive-1/trash'].map((href) => html.includes(`href="${href}"`)),
        html.indexOf('aria-label="More"') < html.indexOf('aria-label="Notifications"'),
      ],
      expected: [[true, true, true, true], true],
    });
  });

  test('an active drive tool', () => {
    const html = markup({ activeId: 'members' });
    assert({
      given: 'Members open, behind More',
      should: 'mark only Members current inside More and light the More tile',
      actual: [
        html.match(/aria-current="[^"]+"/g),
        new RegExp(`class="${spineTileClass('small', true)} summary-plain" aria-label="More"`).test(html),
      ],
      expected: [['aria-current="page"'], true],
    });
  });

  test('Search', () => {
    const onSearch = vi.fn();
    const button = findElement<{ onClick: () => void; 'aria-label': string }>(
      renderRail(props({ onSearch })),
      (element) => element.type === 'button' && (element.props as { 'aria-label'?: string })['aria-label'] === 'Search',
    );
    button?.props.onClick();
    assert({
      given: 'Search clicked',
      should: 'open the palette through the container’s action',
      actual: onSearch.mock.calls.length,
      expected: 1,
    });
  });

  test('the bell slot', () => {
    const html = markup({ bell: <button type="button" aria-label="Notifications, 3 unread">Bell</button> });
    assert({
      given: 'the container’s bell',
      should: 'render it at the foot, after the More entry and before Drive settings',
      actual: [
        html.includes('aria-label="Notifications, 3 unread">Bell</button>'),
        html.indexOf('aria-label="More"') < html.indexOf('aria-label="Notifications, 3 unread"'),
        html.indexOf('aria-label="Notifications, 3 unread"') < html.indexOf('aria-label="Drive settings"'),
      ],
      expected: [true, true, true],
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
      should: 'render it at the foot, after the bell and Drive settings',
      actual: [
        html.indexOf('aria-label="Notifications"') < html.indexOf('aria-label="Drive settings"'),
        html.indexOf('Sign out') > html.indexOf('aria-label="Drive settings"'),
      ],
      expected: [true, true],
    });
  });

  test('no drive', () => {
    const html = markup({ items: railItems(null), tools: secondaryItems(null), more: moreItems(null), settings: settingsItem(null), activeId: null });
    assert({
      given: 'no drive to link to',
      should: 'render every drive destination as a disabled button, leaving Search and the bell working',
      actual: [
        [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]),
        (html.match(/disabled=""/g) ?? []).length,
        /<button[^>]*aria-label="Search">/.test(html),
      ],
      expected: [[], 7, true],
    });
  });

  test('the brand', () => {
    const html = markup();
    assert({
      given: 'a drive switcher',
      should: 'render it above Search and the sections',
      actual: [html.indexOf('data-brand') >= 0, html.indexOf('data-brand') < html.indexOf('aria-label="Search"')],
      expected: [true, true],
    });

    assert({
      given: 'no drive switcher',
      should: 'open the scroll region on Search, with no wrapper for it',
      actual: markup({ brand: null }).startsWith(`<div class="${spineScrollClass}"><button`),
      expected: true,
    });
  });
});

describe('renderRail() drive tool badges', () => {
  test('a drive tool shows its own unread count', () => {
    const html = markup({ unread: { messages: 4, calendar: 2 } });
    assert({
      given: 'two pending calendar invites',
      should: 'label Calendar with its unread count and leave the other tools unbadged',
      actual: [names(html).includes('Calendar, 2 unread'), names(html).includes('Console')],
      expected: [true, true],
    });
  });
});
