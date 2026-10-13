// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import type { FileNode } from '../file-model/file-node';
import { renderFolderView, type FolderViewRenderProps } from './folder-view.render';

afterEach(unmountAll);

const today = '2026-10-05';

const brief: FileNode = {
  id: 'brief',
  name: 'Brief',
  kind: 'page',
  pageType: 'DOCUMENT',
  updatedAt: '2026-10-05T09:12:00.000Z',
};
const drafts: FileNode = {
  id: 'drafts',
  name: 'Drafts',
  kind: 'folder',
  pageType: 'FOLDER',
  updatedAt: '2026-09-18T10:00:00.000Z',
  count: 0,
  children: [],
};
const sheet: FileNode = {
  id: 'budget',
  name: 'Budget',
  kind: 'page',
  pageType: 'SHEET',
  updatedAt: '2025-12-31T10:00:00.000Z',
};
const launch: FileNode = {
  id: 'launch',
  name: 'Launch',
  kind: 'folder',
  pageType: 'FOLDER',
  updatedAt: '2026-10-01T00:00:00.000Z',
  count: 3,
  children: [drafts, brief, sheet],
};
const work: FileNode = {
  id: 'work',
  name: 'Work',
  kind: 'folder',
  pageType: 'FOLDER',
  updatedAt: '2026-10-01T00:00:00.000Z',
  count: 1,
  children: [launch],
};

const props = (overrides: Partial<FolderViewRenderProps> = {}): FolderViewRenderProps => ({
  path: [work, launch],
  filesHref: '/d1/files',
  hrefFor: (pageId) => `/d1/files/${pageId}`,
  pendingIds: [],
  today,
  create: () => {},
  creating: false,
  createError: null,
  ...overrides,
});

const html = (overrides: Partial<FolderViewRenderProps> = {}): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(renderFolderView(props(overrides)));
  return container;
};

/** Each content row as [name, href, icon's page type, kind, modified, machine time]. */
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('table[aria-label="Launch contents"] tbody tr')].map((row) => [
    row.querySelector('[data-name]')?.textContent,
    row.querySelector('a')?.getAttribute('href') ?? null,
    row.getAttribute('data-page-type'),
    row.querySelector('[data-kind]')?.textContent,
    row.querySelector('[data-modified]')?.textContent,
    row.querySelector('time')?.getAttribute('datetime') ?? null,
  ]);

/** The path bar as [text, href or null] per crumb. */
const crumbs = (container: HTMLElement) =>
  [...container.querySelectorAll('nav[aria-label="Folder path"] li')].map((crumb) => [
    crumb.querySelector('a, [aria-current]')?.textContent,
    crumb.querySelector('a')?.getAttribute('href') ?? null,
  ]);

describe('renderFolderView() contents', () => {
  test('a folder’s children, Finder-style', () => {
    assert({
      given: 'a folder holding a folder, a document and a sheet',
      should: 'list each in order as a linked row with its name, page type, kind and when it last changed',
      actual: rows(html()),
      expected: [
        ['Drafts', '/d1/files/drafts', 'FOLDER', 'Folder', 'Sep 18', '2026-09-18T10:00:00.000Z'],
        ['Brief', '/d1/files/brief', 'DOCUMENT', 'Document', 'Today, 9:12 AM', '2026-10-05T09:12:00.000Z'],
        ['Budget', '/d1/files/budget', 'SHEET', 'Sheet', 'Dec 31, 2025', '2025-12-31T10:00:00.000Z'],
      ],
    });
  });

  test('each row’s type icon', () => {
    const container = html();
    assert({
      given: 'a folder, a document and a sheet',
      should: 'draw each row’s icon for its page type, as the tree does (folder, file-text, sheet)',
      actual: [...container.querySelectorAll('tbody tr a svg')].map((icon) =>
        [...icon.classList].find((cls) => cls.startsWith('lucide-') && cls !== 'lucide-icon'),
      ),
      expected: ['lucide-folder', 'lucide-file-text', 'lucide-file-spreadsheet'],
    });
  });

  test('columns', () => {
    assert({
      given: 'the table head',
      should: 'name the Name, Kind and Modified columns',
      actual: [...html().querySelectorAll('thead th')].map((cell) => [cell.textContent, cell.getAttribute('scope')]),
      expected: [
        ['Name', 'col'],
        ['Kind', 'col'],
        ['Modified', 'col'],
      ],
    });
  });

  test('a create in flight', () => {
    const pending: FileNode = { id: 'new-1', name: 'Untitled Document', kind: 'page', pageType: 'DOCUMENT' };
    const container = html({ path: [work, { ...launch, children: [...(launch.children ?? []), pending] }], pendingIds: ['new-1'] });
    const row = container.querySelectorAll('tbody tr')[3];
    assert({
      given: 'a page the viewer is creating here that the server has not named yet',
      should: 'draw its row busy and unlinked, saying it is being created rather than when it changed',
      actual: [
        row?.querySelector('[data-name]')?.textContent,
        row?.querySelector('a'),
        row?.getAttribute('aria-busy'),
        row?.querySelector('[data-modified]')?.textContent,
        row?.className.includes('opacity-60'),
      ],
      expected: ['Untitled Document', null, 'true', 'Creating…', true],
    });
  });
});

describe('renderFolderView() path', () => {
  test('a breadcrumb from the drive to the folder', () => {
    assert({
      given: 'a folder inside a folder',
      should: 'lead from Files through each ancestor, linked, to the folder itself, unlinked and current',
      actual: crumbs(html()),
      expected: [
        ['Files', '/d1/files'],
        ['Work', '/d1/files/work'],
        ['Launch', null],
      ],
    });
  });

  test('the folder is the current crumb', () => {
    const current = html().querySelector('nav[aria-label="Folder path"] [aria-current]');
    assert({
      given: 'the open folder',
      should: 'mark its crumb as the current location',
      actual: [current?.getAttribute('aria-current'), current?.textContent],
      expected: ['location', 'Launch'],
    });
  });

  test('a folder at the top of the drive', () => {
    assert({
      given: 'a folder with no folder above it',
      should: 'lead from Files straight to it',
      actual: crumbs(html({ path: [work] })),
      expected: [
        ['Files', '/d1/files'],
        ['Work', null],
      ],
    });
  });

  test('the region', () => {
    const region = html().querySelector('section');
    assert({
      given: 'a folder opened as the object',
      should: 'be a region named for the folder',
      actual: region?.getAttribute('aria-label'),
      expected: 'Launch',
    });
  });
});

describe('renderFolderView() empty', () => {
  test('a folder with nothing in it', () => {
    const container = html({ path: [work, drafts] });
    const empty = container.querySelector('[data-empty]');
    assert({
      given: 'an empty folder',
      should: 'show the empty state with New page in place of the table, keeping the path',
      actual: [
        empty?.querySelector('h2')?.textContent,
        empty?.querySelector('button')?.textContent,
        container.querySelector('table'),
        crumbs(container).map(([name]) => name),
      ],
      expected: ['This folder is empty', 'New page', null, ['Files', 'Work', 'Drafts']],
    });
  });

  test('a folder node with no children list', () => {
    const bare: FileNode = { id: 'bare', name: 'Bare', kind: 'folder', pageType: 'FOLDER' };
    assert({
      given: 'a folder node that carries no children (the drive tree always sends a list, even an empty one)',
      should: 'draw it as empty rather than fail',
      actual: html({ path: [bare] }).querySelector('[data-empty] h2')?.textContent,
      expected: 'This folder is empty',
    });
  });

  test('New page creates', () => {
    const pressed: string[] = [];
    const container = mount(renderFolderView(props({ path: [drafts], create: () => pressed.push('create') })));
    const button = container.querySelector('[data-empty] button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no New page');
    click(button);
    assert({
      given: 'New page pressed in an empty folder',
      should: 'run the create action once',
      actual: pressed,
      expected: ['create'],
    });
  });

  test('while a create is in flight', () => {
    const button = html({ path: [drafts], creating: true }).querySelector('[data-empty] button');
    assert({
      given: 'a create in this drive still waiting for the server',
      should: 'turn New page off',
      actual: button?.hasAttribute('disabled'),
      expected: true,
    });
  });

  test('a create that failed', () => {
    const container = html({ path: [drafts], createError: 'Could not create the page. Could not reach PageSpace.' });
    assert({
      given: 'the last create failed',
      should: 'say why, as an alert',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Could not create the page. Could not reach PageSpace.',
    });
  });

  test('no folder', () => {
    assert({
      given: 'an empty path',
      should: 'draw nothing',
      actual: renderFolderView(props({ path: [] })),
      expected: null,
    });
  });
});
