import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import { treeRow } from '../file-model/fixtures';
import { fileNodesFrom } from '../file-model/from-api';
import { renderTreeRows, type TreeRowsRenderProps } from './tree-row.render';

/**
 *   Launch (folder) › Brief (doc) › Notes (doc)
 *   Archive (folder, empty)
 *   Roadmap (sheet)
 */
const nodes = fileNodesFrom([
  treeRow('launch', 'FOLDER', [
    treeRow('brief', 'DOCUMENT', [treeRow('notes', 'DOCUMENT', [], { parentId: 'brief', title: 'Notes' })], {
      parentId: 'launch',
      title: 'Brief',
    }),
  ], { title: 'Launch' }),
  treeRow('archive', 'FOLDER', [], { title: 'Archive', position: 1 }),
  treeRow('roadmap', 'SHEET', [], { title: 'Roadmap', position: 2 }),
]);

const props: TreeRowsRenderProps = {
  nodes,
  selectedId: null,
  expandedIds: [],
  pendingIds: [],
  hrefFor: (pageId) => `/d1/files/${pageId}`,
  toggle: () => {},
};

const html = (overrides: Partial<TreeRowsRenderProps> = {}): string =>
  renderToString(<ul>{renderTreeRows({ ...props, ...overrides })}</ul>);

describe('renderTreeRows()', () => {
  test('rows link to their page with prefetch', () => {
    const markup = html();
    assert({
      given: 'the top of a drive',
      should: 'link each row to /[driveId]/files/[pageId] (imago’s basePath added by Link)',
      actual: [...markup.matchAll(/<a[^>]*href="([^"]+)"/g)].map((match) => match[1]),
      expected: ['/d1/files/launch', '/d1/files/archive', '/d1/files/roadmap'],
    });
  });

  test('each link prefetches', () => {
    const rows = renderTreeRows(props) as readonly ReactNode[];
    const links = rows.map((row) =>
      findElement<{ prefetch?: boolean; href?: string }>(row, (element) => typeof element.props.href === 'string'),
    );
    assert({
      given: 'every top-level row',
      should: 'render a Link with prefetch on',
      actual: links.map((link) => link?.props.prefetch),
      expected: [true, true, true],
    });
  });

  test('disclosure', () => {
    const markup = html();
    assert({
      given: 'a folder holding pages, an empty folder and a sheet',
      should: 'give both folders a closed caret and the sheet a spacer, and draw nothing under a closed folder',
      actual: [
        /aria-expanded="false"[^>]*aria-label="Expand Launch"/.test(markup),
        /aria-expanded="false"[^>]*aria-label="Expand Archive"/.test(markup),
        markup.includes('Expand Roadmap'),
        markup.includes('Brief'),
      ],
      expected: [true, true, false, false],
    });
  });

  test('an open branch', () => {
    const markup = html({ expandedIds: ['launch', 'brief'] });
    assert({
      given: 'Launch and the Brief page under it open',
      should: 'nest each level in its own list, and let a page holding pages disclose too',
      actual: [
        /aria-expanded="true"[^>]*aria-label="Collapse Launch"/.test(markup),
        /aria-expanded="true"[^>]*aria-label="Collapse Brief"/.test(markup),
        markup.includes('<ul class="flex flex-col gap-1 pl-tree-step" aria-label="Launch">'),
        markup.includes('href="/d1/files/notes"'),
      ],
      expected: [true, true, true, true],
    });
  });

  test('the caret toggles its page', () => {
    const toggled: string[] = [];
    const rows = renderTreeRows({ ...props, toggle: (pageId) => toggled.push(pageId) }) as readonly ReactNode[];
    const caret = findElement<{ onClick?: () => void }>(rows[0], (element) => element.type === 'button');
    caret?.props.onClick?.();
    assert({
      given: 'a click on Launch’s caret',
      should: 'toggle Launch',
      actual: toggled,
      expected: ['launch'],
    });
  });

  test('selection tint', () => {
    const markup = html({ selectedId: 'archive' });
    assert({
      given: 'the open page',
      should: 'tint exactly its row and mark exactly its link as the current page',
      actual: [
        markup.match(/bg-accent-soft/g)?.length,
        markup.match(/aria-current="page"/g)?.length,
        /<a(?=[^>]*href="\/d1\/files\/archive")(?=[^>]*aria-current="page")/.test(markup),
      ],
      expected: [1, 1, true],
    });
  });

  test('type icons and counts', () => {
    const markup = html();
    assert({
      given: 'folders and a sheet',
      should: 'draw each with its page type’s glyph and show a folder’s item count',
      actual: [
        markup.includes('lucide-folder'),
        markup.includes('lucide-file-spreadsheet'),
        /Launch<\/span><span class="flex-none text-2xs text-ink-faint">1<\/span>/.test(markup),
        /Archive<\/span><span class="flex-none text-2xs text-ink-faint">0<\/span>/.test(markup),
      ],
      expected: [true, true, true, true],
    });
  });

  test('a row being created', () => {
    const markup = html({ pendingIds: ['roadmap'], selectedId: 'roadmap' });
    assert({
      given: 'a row the server has not listed yet that is the open page',
      should: 'draw it busy and faded, not as a link, still marked current',
      actual: [
        markup.includes('href="/d1/files/roadmap"'),
        /<span[^>]*aria-busy="true"[^>]*aria-current="page"/.test(markup),
        markup.includes('opacity-60'),
      ],
      expected: [false, true, true],
    });
  });
});

describe('renderTreeRows() multi-select and row actions (IMC-9.6, IMC-9.3)', () => {
  test('select mode gives each row a checkbox named for its page', () => {
    const markup = html({
      selection: { selectedIds: new Set(['roadmap']), toggle: () => {} },
    });
    assert({
      given: 'select mode on, with one row picked',
      should: 'name a checkbox for each top-level row, checked only for the picked page',
      actual: [...markup.matchAll(/<input[^>]*aria-label="Select ([^"]+)"[^>]*>/g)].map((match) => [match[1], /checked=""/.test(match[0])]),
      expected: [
        ['Launch', false],
        ['Archive', false],
        ['Roadmap', true],
      ],
    });
  });

  test('rows have no checkboxes outside select mode', () => {
    assert({
      given: 'select mode off',
      should: 'render no checkboxes',
      actual: html().includes('type="checkbox"'),
      expected: false,
    });
  });

  test('a row carries the container’s actions trigger', () => {
    const markup = html({ renderRowActions: (node) => <button type="button" aria-label={`Page actions for ${node.name}`}>…</button> });
    assert({
      given: 'a container that supplies a row action',
      should: 'render it on every row',
      actual: [...markup.matchAll(/aria-label="Page actions for ([^"]+)"/g)].map((match) => match[1]),
      expected: ['Launch', 'Archive', 'Roadmap'],
    });
  });
});

describe('renderTreeRows() pending rows that are not open', () => {
  test('a row being created that is not the open page carries no current marker', () => {
    const markup = html({ pendingIds: ['roadmap'], selectedId: 'other' });
    assert({
      given: 'a pending row that is not the open page',
      should: 'draw it busy without aria-current',
      actual: [/<span[^>]*aria-busy="true"/.test(markup), /aria-busy="true"[^>]*aria-current/.test(markup)],
      expected: [true, false],
    });
  });
});
