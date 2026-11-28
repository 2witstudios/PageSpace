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

/** The Folder tools strip, as [count label, Browse files href, New document button]. */
const strip = (container: HTMLElement) => {
  const toolbar = container.querySelector('[role="toolbar"][aria-label="Folder tools"]');
  const buttons = [...(toolbar?.querySelectorAll('button') ?? [])];
  return [
    toolbar?.querySelector('span')?.textContent,
    toolbar?.querySelector('a')?.getAttribute('href') ?? null,
    buttons.map((button) => button.textContent),
  ];
};

describe('renderFolderView() contents', () => {
  test('a folder’s children, in order, as linked rows with their name, type, kind and when they last changed', () => {
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

  test('agent and task list kinds use the board’s names', () => {
    const agent: FileNode = { id: 'a1', name: 'Planner', kind: 'page', pageType: 'AI_CHAT', updatedAt: '2026-10-05T09:12:00.000Z' };
    const tasks: FileNode = { id: 't1', name: 'Launch tasks', kind: 'page', pageType: 'TASK_LIST', updatedAt: '2026-10-05T09:12:00.000Z' };
    const folder: FileNode = { ...launch, count: 2, children: [agent, tasks] };
    assert({
      given: 'a folder holding an agent page and a task list',
      should: 'call them "AI agent" and "Task list"',
      actual: rows(html({ path: [work, folder] })).map((row) => row[3]),
      expected: ['AI agent', 'Task list'],
    });
  });

  test('each row’s coloured type dot', () => {
    const container = html();
    assert({
      given: 'a folder, a document and a sheet',
      should: 'draw each row a dot in its page type’s colour',
      actual: [...container.querySelectorAll('tbody tr [data-dot]')].map((dot) =>
        [...dot.classList].find((cls) => cls.startsWith('text-type-')),
      ),
      expected: ['text-type-folder', 'text-type-doc', 'text-type-sheet'],
    });
  });

  test('columns', () => {
    assert({
      given: 'the table head',
      should: 'name the Name, Type and Modified columns',
      actual: [...html().querySelectorAll('thead th')].map((cell) => [cell.textContent, cell.getAttribute('scope')]),
      expected: [
        ['Name', 'col'],
        ['Type', 'col'],
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
      should: 'draw its row busy and unlinked, with Creating… beside its name and no time yet',
      actual: [
        row?.querySelector('[data-name]')?.textContent,
        row?.querySelector('a'),
        row?.getAttribute('aria-busy'),
        row?.querySelector('[data-modified]')?.textContent,
        row?.textContent?.includes('Creating…'),
        row?.className.includes('opacity-60'),
      ],
      expected: ['Untitled Document', null, 'true', '—', true, true],
    });
  });
});

describe('renderFolderView() strip', () => {
  test('the folder’s name and page count, Browse files and New document', () => {
    assert({
      given: 'a folder holding three pages',
      should: 'show "<name> · <n> pages", a Browse files link to the files section and a New document button',
      actual: strip(html()),
      expected: ['Launch · 3 pages', '/d1/files', ['New document']],
    });
  });

  test('one page reads singular', () => {
    assert({
      given: 'a folder holding one page',
      should: 'count it as "1 page"',
      actual: strip(html({ path: [work, { ...launch, children: [brief] }] }))[0],
      expected: 'Launch · 1 page',
    });
  });

  test('the in-body path is gone', () => {
    assert({
      given: 'a folder inside a folder',
      should: 'draw no folder path nav in the body (the path lives in the page head)',
      actual: html().querySelector('nav[aria-label="Folder path"]'),
      expected: null,
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
      should: 'show the empty state in place of the table, with the strip still counting zero pages',
      actual: [
        empty?.querySelector('h2')?.textContent,
        container.querySelector('table'),
        strip(container)[0],
      ],
      expected: ['This folder is empty', null, 'Drafts · 0 pages'],
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

  test('New document creates', () => {
    const pressed: string[] = [];
    const container = mount(renderFolderView(props({ path: [drafts], create: () => pressed.push('create') })));
    const button = [...container.querySelectorAll('[role="toolbar"] button')].find(
      (candidate) => candidate.textContent === 'New document',
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error('no New document');
    click(button);
    assert({
      given: 'New document pressed in an empty folder',
      should: 'run the create action once',
      actual: pressed,
      expected: ['create'],
    });
  });

  test('while a create is in flight', () => {
    const button = html({ path: [drafts], creating: true }).querySelector('[role="toolbar"] button');
    assert({
      given: 'a create in this drive still waiting for the server',
      should: 'turn New document off',
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
