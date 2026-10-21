// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { renderFilesBrowser, type BrowserRow, type FilesBrowserRenderProps } from './files-browser.render';
import { DEFAULT_SORT } from './files-browser-sort';

afterEach(unmountAll);

const row = (id: string, title: string, overrides: Partial<BrowserRow> = {}): BrowserRow => ({
  id,
  title,
  pageType: 'DOCUMENT',
  typeLabel: 'Document',
  updated: '10/5/2026',
  created: '9/1/2026',
  href: `/d1/files/${id}`,
  pending: false,
  menuLabel: `Actions for ${title}`,
  menuOpen: false,
  onOpenMenu: vi.fn(),
  onContextMenu: vi.fn(),
  ...overrides,
});

const base = (overrides: Partial<FilesBrowserRenderProps> = {}): FilesBrowserRenderProps => ({
  crumbs: [
    { href: '/d1/files/browse', label: 'Studio', current: false },
    { href: '/d1/files/browse/launch', label: 'Launch', current: true },
  ],
  view: 'list',
  onView: vi.fn(),
  sort: DEFAULT_SORT,
  onSort: vi.fn(),
  rows: [row('brief', 'Brief'), row('plan', 'Plan', { typeLabel: 'Ai Chat', updated: null })],
  folderName: 'Launch',
  empty: false,
  dropCount: 0,
  onNewPage: vi.fn(),
  onUpload: vi.fn(),
  onDragEnter: vi.fn(),
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
  picker: null,
  createError: null,
  uploadNotice: null,
  menu: null,
  onCloseMenu: vi.fn(),
  ...overrides,
});

const show = (props: FilesBrowserRenderProps): HTMLElement => mount(renderFilesBrowser(props));

const button = (container: HTMLElement, label: string): HTMLButtonElement | null =>
  [...container.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label) ?? null;

describe('the Files strip', () => {
  test('breadcrumb, List and Grid view, and New Page', () => {
    const container = show(base());
    assert({
      given: 'a folder two levels down, in list view',
      should: 'draw the breadcrumb with the current folder marked, List pressed, Grid not, and a New Page button',
      actual: [
        container.querySelector('[role="toolbar"]')?.getAttribute('aria-label'),
        container.querySelector('nav[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent,
        button(container, 'List view')?.getAttribute('aria-pressed'),
        button(container, 'Grid view')?.getAttribute('aria-pressed'),
        [...container.querySelectorAll('button')].some((candidate) => candidate.textContent === 'New Page'),
      ],
      expected: ['Pages', 'Launch', 'true', 'false', true],
    });
  });

  test('Grid view pressed', () => {
    const container = show(base({ view: 'grid' }));
    assert({
      given: 'the grid view chosen',
      should: 'press Grid view and draw tiles instead of a table',
      actual: [button(container, 'Grid view')?.getAttribute('aria-pressed'), container.querySelector('table'), container.querySelectorAll('[data-page-type]').length],
      expected: ['true', null, 2],
    });
  });
});

describe('the list', () => {
  test('sortable column headers with aria-sort, and the sorted column', () => {
    const container = show(base({ sort: { key: 'updatedAt', dir: 'desc' } }));
    const heads = [...container.querySelectorAll('th[aria-sort]')].map((head) => [head.textContent, head.getAttribute('aria-sort')]);
    assert({
      given: 'the list sorted by Last Modified descending',
      should: 'mark that column descending and the others none, with Name, Type, Last Modified and Created as sort buttons',
      actual: heads,
      expected: [
        ['Name', 'none'],
        ['Type', 'none'],
        ['Last Modified', 'descending'],
        ['Created', 'none'],
      ],
    });
  });

  test('a row: its type label, its date (or a dash), and its own actions button', () => {
    const container = show(base());
    const rows = [...container.querySelectorAll('tbody tr')];
    assert({
      given: 'a page changed on a day and a page with no time yet',
      should: 'show the type label, the date or a dash, and an Actions button named for the page',
      actual: rows.map((tr) => [
        tr.querySelector('[data-type]')?.textContent,
        tr.querySelector('[data-modified]')?.textContent,
        tr.querySelector('button[data-menu-trigger]')?.getAttribute('aria-label'),
      ]),
      expected: [
        ['Document', '10/5/2026', 'Actions for Brief'],
        ['Ai Chat', '—', 'Actions for Plan'],
      ],
    });
  });

  test('the help line under the list', () => {
    const container = show(base());
    assert({
      given: 'a list of pages',
      should: 'say how to reach the row actions',
      actual: container.textContent?.includes('Right-click a row (or use its “…”) for Open, Rename, Favorite, Move, Copy and Trash.'),
      expected: true,
    });
  });
});

describe('the empty folder', () => {
  test('the empty state with its two actions', () => {
    const container = show(base({ rows: [], empty: true }));
    const state = container.querySelector('[data-testid="files-empty-state"]');
    assert({
      given: 'a folder with no pages in it',
      should: 'draw the "No child pages" state with Upload files and Create page',
      actual: [
        state?.querySelector('p')?.textContent,
        [...(state?.querySelectorAll('button') ?? [])].map((candidate) => candidate.textContent),
        container.querySelector('table'),
      ],
      expected: ['No child pages', ['Upload files', 'Create page'], null],
    });
  });

  test('files dragged over it name the count and the folder', () => {
    const container = show(base({ rows: [], empty: true, dropCount: 3 }));
    assert({
      given: 'three files dragged over an empty folder',
      should: 'say they will be uploaded into the folder',
      actual: container.querySelector('[data-testid="files-empty-state"] p:last-child')?.textContent,
      expected: 'Drop to upload 3 files into Launch',
    });
  });
});

describe('the row menu', () => {
  test('its items, in order, under the page’s label', () => {
    const container = show(
      base({
        menu: {
          label: 'Actions for Brief',
          x: 10,
          y: 20,
          entries: [
            { kind: 'item', key: 'open', label: 'Open', href: '/d1/files/brief', onSelect: vi.fn() },
            { kind: 'item', key: 'rename', label: 'Rename', onSelect: vi.fn() },
            { kind: 'item', key: 'favorite', label: 'Favorite', onSelect: vi.fn() },
            { kind: 'separator', key: 'sep' },
            { kind: 'item', key: 'trash', label: 'Trash', danger: true, onSelect: vi.fn() },
          ],
        },
      }),
    );
    const menu = container.querySelector('[role="menu"]');
    assert({
      given: 'a row whose actions are open',
      should: 'show a menu named for the page with its items as menu items, separated',
      actual: [
        menu?.getAttribute('aria-label'),
        [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => item.textContent),
        menu?.querySelectorAll('[role="separator"]').length,
      ],
      expected: ['Actions for Brief', ['Open', 'Rename', 'Favorite', 'Trash'], 1],
    });
  });
});
