// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Drive } from '@pagespace/lib/types';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { AccountDrivesView, type AccountDrivesViewProps } from './account-drives';
import { DEFAULT_SORT, groupDrives } from './account-drives-model';

afterEach(unmountAll);

const drive = (overrides: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: overrides.id,
  ownerId: 'me',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
  ...overrides,
});

const owned = drive({ id: 'a', name: 'Studio' });
const shared = drive({ id: 'b', name: 'Ops', isOwned: false, role: 'MEMBER', ownerId: 'other' });

const handlers = () => ({
  onLayout: vi.fn(),
  onSort: vi.fn(),
  onNewDrive: vi.fn(),
  onToggleMenu: vi.fn(),
  onAction: vi.fn(),
  onOpen: vi.fn(),
});

const view = (overrides: Partial<AccountDrivesViewProps> = {}) => {
  const mocks = handlers();
  const base = {
    groups: groupDrives([owned, shared], new Set(), DEFAULT_SORT),
    layout: 'list' as const,
    sort: DEFAULT_SORT,
    favoriteIds: new Set<string>(),
    openMenuId: null,
  };
  return { props: mocks, container: mount(<AccountDrivesView {...base} {...mocks} {...overrides} />) };
};

const button = (container: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === name || item.getAttribute('aria-label') === name);
  if (found === undefined) throw new Error(`${name} is missing`);
  return found;
};

describe('AccountDrivesView', () => {
  test('renders one h1 and the grouped table with its sortable headers and an Actions column', () => {
    const { container } = view();
    assert({
      given: 'an owned drive and a shared drive',
      should: 'show the title, the group rows and the sortable headers',
      actual: {
        h1: container.querySelector('h1')?.textContent,
        groups: [...container.querySelectorAll('th[colspan="5"]')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
        headers: [...container.querySelectorAll('thead th')].map((cell) => cell.textContent),
      },
      expected: {
        h1: 'Drives',
        groups: ['Personal 1', 'Shared with you 1'],
        headers: ['Name', 'Role', 'Last accessed', 'Created', 'Actions'],
      },
    });
  });

  test('clicking a sortable header asks for that column to be sorted', () => {
    const { container, props } = view();
    click(button(container, 'Created'));
    assert({
      given: 'a click on the Created header',
      should: 'report the sort key',
      actual: props.onSort.mock.calls,
      expected: [['createdAt']],
    });
  });

  test('the List and Grid buttons show which layout is active and report the switch', () => {
    const { container, props } = view({ layout: 'list' });
    click(button(container, 'Grid'));
    assert({
      given: 'the list layout',
      should: 'mark List pressed and report Grid when Grid is pressed',
      actual: { listPressed: button(container, 'List').getAttribute('aria-pressed'), requested: props.onLayout.mock.calls },
      expected: { listPressed: 'true', requested: [['grid']] },
    });
  });

  test('grid view draws each drive as a button that opens it', () => {
    const { container, props } = view({ layout: 'grid' });
    const card = [...container.querySelectorAll('button')].find((item) => item.textContent?.startsWith('Ops'));
    if (card === undefined) throw new Error('Ops card is missing');
    click(card);
    assert({
      given: 'grid view and a shared drive',
      should: 'show it as a button and report which drive was opened',
      actual: { table: container.querySelector('table'), opened: props.onOpen.mock.calls[0]?.[0].id },
      expected: { table: null, opened: 'b' },
    });
  });

  test('New drive reports the press', () => {
    const { container, props } = view();
    click(button(container, 'New drive'));
    assert({
      given: 'a press on New drive',
      should: 'ask for the create-drive flow',
      actual: props.onNewDrive.mock.calls.length,
      expected: 1,
    });
  });

  test('an open row menu lists the actions the drive allows, and a member sees no Rename or Move to trash', () => {
    const { container } = view({ openMenuId: 'b' });
    assert({
      given: 'the menu open on a shared drive where the viewer is a member',
      should: 'list Open and Favorite only',
      actual: [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
      expected: ['Open', 'Favorite'],
    });
  });

  test('the owned drive’s menu offers Rename and Move to trash, and choosing one reports it', () => {
    const { container, props } = view({ openMenuId: 'a' });
    click(button(container, 'Move to trash'));
    assert({
      given: 'a press on Move to trash in the owned drive’s menu',
      should: 'report the action against that drive',
      actual: props.onAction.mock.calls.map((call) => [call[0].id, call[1]]),
      expected: [['a', 'trash']],
    });
  });

  test('a favorite reads Unfavorite in the menu', () => {
    const { container } = view({ openMenuId: 'a', favoriteIds: new Set(['a']), groups: groupDrives([owned], new Set(['a']), DEFAULT_SORT) });
    assert({
      given: 'the owned drive is a favorite',
      should: 'offer Unfavorite',
      actual: [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
      expected: ['Open', 'Rename', 'Unfavorite', 'Move to trash'],
    });
  });

  test('a home drive is marked Home, and no organization group or visibility pill appears', () => {
    const home = drive({ id: 'h', name: 'Home drive', kind: 'HOME' });
    const { container } = view({ groups: groupDrives([home], new Set(), DEFAULT_SORT) });
    assert({
      given: 'the viewer’s home drive',
      should: 'mark it Home and show no organization group',
      actual: {
        badge: [...container.querySelectorAll('span')].some((span) => span.textContent === 'Home'),
        org: container.textContent?.includes('Organization'),
        open: container.textContent?.includes('Open/Restricted'),
      },
      expected: { badge: true, org: false, open: false },
    });
  });

  test('with no drives it says so and draws no table', () => {
    const { container } = view({ groups: [] });
    assert({
      given: 'no drives at all',
      should: 'show the empty line and no table',
      actual: { table: container.querySelector('table'), text: container.textContent?.includes('No drives yet') },
      expected: { table: null, text: true },
    });
  });
});
