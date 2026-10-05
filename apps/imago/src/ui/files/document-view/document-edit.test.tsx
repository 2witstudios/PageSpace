// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { useSWRConfig, type ScopedMutator } from 'swr';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { blur, click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { fakeRealtime } from '../../test-support/fake-realtime';
import { fakeWeb, type FakeRoute, type Recorded } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { documentDraftOf, isEditingDocument } from '../files-plugin/files-plugin';
import { pageRow, treeRow } from '../file-model/fixtures';
import { useFileTree } from '../use-file-tree/use-file-tree';
import { DOCUMENT_SAVE_DELAY_MS } from '../document-edit/document-saver';
import { CONFLICT_NOTICE, DRAFT_RESTORED_NOTICE, REFUSED_NOTICE } from '../document-edit/document-notice.render';
import { reloadsOn } from './document-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { PageObject } = await import('../page-object/page-object');
const { PageView } = await import('../page-view/page-view');

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(unmountAll);

/** Waits, flushing React between tries, until `check` stops throwing; long enough to cover the save pause. */
const settle = async (check: () => void, timeout = DOCUMENT_SAVE_DELAY_MS * 3): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
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

/** Lets a little time pass with React flushed, for asserting that nothing happens. */
const pass = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const PAGE = 'GET /api/pages/notes';
const SAVE = 'PATCH /api/pages/notes';
const RIGHTS = 'GET /api/pages/notes/permissions/check';
const TREE = 'GET /api/drives/d1/pages';

/** The stored page: what GET and a successful PATCH answer. */
const stored = { title: 'Notes', content: '<p>Stored</p>', revision: 3 };

const pageBody = () =>
  Response.json({
    ...pageRow('notes', 'DOCUMENT', { parentId: 'brief', title: stored.title }),
    content: stored.content,
    revision: stored.revision,
    children: [],
    messages: [],
  });

const getPage: FakeRoute = () => pageBody();

/** apps/web's PATCH: applies the change and bumps the revision, or 409s on a stale one. */
const savePage: FakeRoute = (request: Recorded) => {
  const body = request.body as { content?: string; title?: string; expectedRevision?: number };
  if (body.expectedRevision !== stored.revision) {
    return Response.json(
      { error: 'Page was modified', currentRevision: stored.revision, expectedRevision: body.expectedRevision },
      { status: 409 },
    );
  }
  if (body.content !== undefined) stored.content = body.content;
  if (body.title !== undefined) stored.title = body.title;
  stored.revision += 1;
  return pageBody();
};

const rights = (canEdit: boolean): FakeRoute => () =>
  Response.json({ canView: true, canEdit, canShare: false, canDelete: false });

const tree: FakeRoute = () =>
  Response.json([
    treeRow('brief', 'DOCUMENT', [treeRow('notes', 'DOCUMENT', [], { parentId: 'brief', title: stored.title })], {
      title: 'Brief',
    }),
  ]);

beforeEach(() => {
  stored.title = 'Notes';
  stored.content = '<p>Stored</p>';
  stored.revision = 3;
});

/** The tree as a sibling pane holds it: every title, top first. */
const treeTitles: { current: string[] } = { current: [] };
function TreeProbe(): ReactNode {
  const { nodes } = useFileTree('d1');
  const walk = (list: typeof nodes): string[] => (list ?? []).flatMap((node) => [node.name, ...walk(node.children)]);
  treeTitles.current = walk(nodes);
  return null;
}

/** SWR's mutate, for a test that plays a revalidation landing. */
const swr: { mutate: ScopedMutator | null } = { mutate: null };
function SWRProbe(): ReactNode {
  swr.mutate = useSWRConfig().mutate;
  return null;
}

const show = (routes: Record<string, FakeRoute>, { withObject = true } = {}) => {
  const web = fakeWeb({ [PAGE]: getPage, [SAVE]: savePage, [RIGHTS]: rights(true), [TREE]: tree, ...routes });
  const realtime = fakeRealtime();
  const object = (
    <PageObject driveId="d1" pageId="notes">
      <PageView driveId="d1" pageId="notes" />
    </PageObject>
  );
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={realtime.client}>
        <SWRProbe />
        <TreeProbe />
        {withObject ? object : null}
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, realtime, container };
};

type EditorElement = HTMLElement & { editor?: Editor };

const bodyOf = (container: HTMLElement) => container.querySelector<EditorElement>('[data-document-body]');
const titleField = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[aria-label="Title"]');
const textOf = (container: HTMLElement) => bodyOf(container)?.textContent;

/** The viewer clicks into the title field. */
const focusTitle = (container: HTMLElement): HTMLInputElement => {
  const field = titleField(container) as HTMLInputElement;
  act(() => {
    field.focus();
  });
  return field;
};

/** Waits for the document to be open and editable. */
const editable = (container: HTMLElement) =>
  settle(() => {
    if (bodyOf(container)?.getAttribute('contenteditable') !== 'true') throw new Error('not editable yet');
  });

/** The viewer types: the editor's document becomes `html`, as a keystroke would make it. */
const type = (container: HTMLElement, html: string) =>
  act(() => {
    bodyOf(container)?.editor?.commands.setContent(html, { emitUpdate: true });
  });

const saves = (web: ReturnType<typeof fakeWeb>) => web.requests.filter((request) => request.method === 'PATCH');

describe('editing a document in the Files object', () => {
  test('given edit rights, the editor is editable and saves debounced', async () => {
    const { container, web, realtime } = show({});
    await editable(container);
    const socket = realtime.live()[0];
    if (socket) socket.id = 'sock-me';

    await type(container, '<p>D</p>');
    await type(container, '<p>Dr</p>');
    await type(container, '<p>Draft</p>');
    const beforePause = saves(web).length;
    const stateWhileTyping = container.querySelector('[data-save-state]')?.textContent;
    await settle(() => {
      if (container.querySelector('[data-save-state]')?.getAttribute('data-save-state') !== 'saved') throw new Error('not saved');
    });
    const sent = saves(web);
    const saveIndex = web.requests.findIndex((request) => request.method === 'PATCH');
    assert({
      given: 'a viewer the server lets edit, typing three times without a pause',
      should:
        'make the body an editable textbox with an editable title, then send one PATCH to the page route after the pause, with CSRF, the stored revision, the latest text and this tab’s socket id',
      actual: {
        role: bodyOf(container)?.getAttribute('role'),
        readonly: bodyOf(container)?.getAttribute('aria-readonly'),
        title: titleField(container)?.value,
        beforePause,
        stateWhileTyping,
        sent: sent.map((request) => [request.csrf, request.body]),
        socketId: web.headers[saveIndex]?.get('X-Socket-ID'),
        stored: stored.content,
        state: container.querySelector('[data-save-state]')?.textContent,
      },
      expected: {
        role: 'textbox',
        readonly: null,
        title: 'Notes',
        beforePause: 0,
        stateWhileTyping: 'Unsaved changes',
        sent: [['tok-1', { content: '<p>Draft</p>', expectedRevision: 3 }]],
        socketId: 'sock-me',
        stored: '<p>Draft</p>',
        state: 'Saved',
      },
    });
  });

  test('without edit rights', async () => {
    const { container, web } = show({ [RIGHTS]: rights(false) });
    await settle(() => {
      if (web.count(RIGHTS) === 0 || !textOf(container)) throw new Error('not asked yet');
    });
    await pass(50);
    assert({
      given: 'a viewer the server does not let edit',
      should: 'keep the document read-only, with a plain title and no save state',
      actual: [
        bodyOf(container)?.getAttribute('contenteditable'),
        bodyOf(container)?.getAttribute('aria-readonly'),
        titleField(container),
        container.querySelector('[data-reading-column] h1')?.textContent,
        container.querySelector('[data-save-state]'),
      ],
      expected: ['false', 'true', null, 'Notes', null],
    });
  });

  test('leaving the editor saves at once', async () => {
    const { container, web } = show({});
    await editable(container);
    await type(container, '<p>Quick</p>');
    // The editor loses focus. (Only the event: focusing first makes ProseMirror scroll, which jsdom cannot measure.)
    await act(() => {
      bodyOf(container)?.editor?.view.dom.dispatchEvent(new FocusEvent('blur'));
    });
    await settle(() => {
      if (saves(web).length === 0) throw new Error('not sent');
    }, DOCUMENT_SAVE_DELAY_MS / 2);
    assert({
      given: 'text typed, then the editor left before the pause',
      should: 'save it without waiting for the pause',
      actual: saves(web).map((request) => request.body),
      expected: [{ content: '<p>Quick</p>', expectedRevision: 3 }],
    });
  });

  test('closing the document saves what is waiting', async () => {
    const { container, web } = show({});
    await editable(container);
    await type(container, '<p>Last words</p>');
    unmountAll();
    await settle(() => {
      if (saves(web).length === 0) throw new Error('not sent');
    }, DOCUMENT_SAVE_DELAY_MS / 2);
    await pass(20);
    assert({
      given: 'text typed, then the document closed before the pause',
      should: 'save it as it closes, then let SWR have the page again',
      actual: [saves(web).map((request) => request.body), isEditingDocument(getUiState(), 'notes')],
      expected: [[{ content: '<p>Last words</p>', expectedRevision: 3 }], false],
    });
  });

  test('a 409 conflict keeps the local copy and surfaces it', async () => {
    const { container, web } = show({});
    await editable(container);
    // Someone else saves first.
    stored.content = '<p>Theirs</p>';
    stored.revision = 4;
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-conflict]')) throw new Error('no conflict');
    });
    await type(container, '<p>Mine, more</p>');
    await pass(DOCUMENT_SAVE_DELAY_MS + 200);
    assert({
      given: 'a save the server refuses because someone else saved first, then more typing',
      should: 'keep the viewer’s text, say so, keep the page out of SWR’s reach, and send nothing more',
      actual: {
        text: textOf(container),
        notice: container.querySelector('[data-save-conflict] p')?.textContent,
        alert: container.querySelector('[data-save-conflict]')?.getAttribute('role'),
        saves: saves(web).length,
        paused: isEditingDocument(getUiState(), 'notes'),
        stored: stored.content,
      },
      expected: {
        text: 'Mine, more',
        notice: CONFLICT_NOTICE,
        alert: 'alert',
        saves: 1,
        paused: true,
        stored: '<p>Theirs</p>',
      },
    });
  });

  test('settling a conflict by keeping my version', async () => {
    const { container, web } = show({});
    await editable(container);
    stored.content = '<p>Theirs</p>';
    stored.revision = 4;
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-conflict]')) throw new Error('no conflict');
    });
    const keep = [...container.querySelectorAll('[data-save-conflict] button')].find(
      (button) => button.textContent === 'Keep my version',
    ) as HTMLButtonElement;
    click(keep);
    await settle(() => {
      if (container.querySelector('[data-save-state]')?.getAttribute('data-save-state') !== 'saved') throw new Error('not saved');
    });
    assert({
      given: 'a conflict the viewer settles by keeping their text',
      should: 'save it over the revision now stored, and clear the conflict',
      actual: [saves(web).at(-1)?.body, stored.content, container.querySelector('[data-save-conflict]')],
      expected: [{ content: '<p>Mine</p>', expectedRevision: 4 }, '<p>Mine</p>', null],
    });
  });

  test('settling a conflict by using the saved version', async () => {
    const { container, web } = show({});
    await editable(container);
    stored.content = '<p>Theirs</p>';
    stored.revision = 4;
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-conflict]')) throw new Error('no conflict');
    });
    const useSaved = [...container.querySelectorAll('[data-save-conflict] button')].find(
      (button) => button.textContent === 'Use the saved version',
    ) as HTMLButtonElement;
    click(useSaved);
    await settle(() => {
      if (textOf(container) !== 'Theirs') throw new Error('not reloaded');
    });
    await type(container, '<p>Theirs, edited</p>');
    await settle(() => {
      if (saves(web).length < 2) throw new Error('not saved');
    });
    assert({
      given: 'a conflict the viewer settles by taking the stored copy, then an edit',
      should: 'show the stored copy, and save the next edit against its revision',
      actual: [container.querySelector('[data-save-conflict]'), saves(web).at(-1)?.body],
      expected: [null, { content: '<p>Theirs, edited</p>', expectedRevision: 4 }],
    });
  });

  test('a 403 on save', async () => {
    const { container, web } = show({
      [SAVE]: () => Response.json({ error: 'You need edit permission to modify this page' }, { status: 403 }),
    });
    await editable(container);
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-refused]')) throw new Error('not refused');
    });
    assert({
      given: 'a save the server refuses for lack of edit rights',
      should: 'turn the document read-only, keep the viewer’s text and tell them it was not saved',
      actual: [
        bodyOf(container)?.getAttribute('contenteditable'),
        titleField(container),
        textOf(container),
        container.querySelector('[data-save-refused] p')?.textContent,
        saves(web).length,
      ],
      expected: ['false', null, 'Mine', REFUSED_NOTICE, 1],
    });
  });

  test('a failed save', async () => {
    let failing = true;
    const { container, web } = show({
      [SAVE]: (request) =>
        failing ? Response.json({ error: 'Failed to update page' }, { status: 500 }) : savePage(request),
    });
    await editable(container);
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-failed]')) throw new Error('not failed');
    });
    const shown = [textOf(container), container.querySelector('[data-save-failed] p')?.textContent];
    failing = false;
    click(container.querySelector('[data-save-failed] button') as HTMLButtonElement);
    await settle(() => {
      if (container.querySelector('[data-save-state]')?.getAttribute('data-save-state') !== 'saved') throw new Error('not saved');
    });
    assert({
      given: 'a save the server fails, then Try again',
      should: 'keep the text and show the error, then save the same text',
      actual: [shown, saves(web).map((request) => request.body), stored.content],
      expected: [
        ['Mine', 'Failed to update page'],
        [
          { content: '<p>Mine</p>', expectedRevision: 3 },
          { content: '<p>Mine</p>', expectedRevision: 3 },
        ],
        '<p>Mine</p>',
      ],
    });
  });
});

describe('someone else’s save (page:content-updated)', () => {
  test('while the viewer is not editing', async () => {
    const { container, web, realtime } = show({});
    await editable(container);
    const editorNode = bodyOf(container);
    stored.content = '<p>Theirs</p>';
    stored.revision = 4;
    const before = web.count(PAGE);
    realtime.emit('page:content-updated', { driveId: 'd1', pageId: 'notes', socketId: 'sock-other' });
    await settle(() => {
      if (textOf(container) !== 'Theirs') throw new Error('not reloaded');
    });
    assert({
      given: 'another tab’s save of this page while the viewer holds nothing unsaved',
      should: 'reload the page and draw the new content in the same editor',
      actual: [web.count(PAGE) - before, bodyOf(container) === editorNode],
      expected: [1, true],
    });
  });

  test('while the viewer is editing', async () => {
    const { container, web, realtime } = show({});
    await editable(container);
    await type(container, '<p>Mine</p>');
    stored.content = '<p>Theirs</p>';
    stored.revision = 4;
    const before = web.count(PAGE);
    realtime.emit('page:content-updated', { driveId: 'd1', pageId: 'notes', socketId: 'sock-other' });
    await pass(50);
    assert({
      given: 'another tab’s save while the viewer has unsaved text',
      should: 'not reload over it',
      actual: [web.count(PAGE) - before, textOf(container)],
      expected: [0, 'Mine'],
    });
  });

  test('the viewer’s own save echoed back, and other pages', async () => {
    const { container, web, realtime } = show({});
    await editable(container);
    const socket = realtime.live()[0];
    if (socket) socket.id = 'sock-me';
    const before = web.count(PAGE);
    realtime.emit('page:content-updated', { driveId: 'd1', pageId: 'notes', socketId: 'sock-me' });
    realtime.emit('page:content-updated', { driveId: 'd1', pageId: 'other', socketId: 'sock-other' });
    await pass(50);
    assert({
      given: 'a content event this tab’s save caused, and one for another page',
      should: 'reload nothing',
      actual: web.count(PAGE) - before,
      expected: 0,
    });
  });
});

describe('revalidation mid-edit', () => {
  test('a newer copy landing in SWR while the viewer types', async () => {
    const { container, web } = show({});
    await editable(container);
    await type(container, '<p>Mine</p>');
    const before = web.count(PAGE);
    // A revalidation asked for now is held off; one that lands anyway is not drawn.
    await act(async () => {
      await swr.mutate?.('/api/pages/notes');
    });
    await act(async () => {
      await swr.mutate?.(
        '/api/pages/notes',
        (current: unknown) => ({ ...(current as object), content: '<p>Theirs</p>', revision: 9 }),
        { revalidate: false },
      );
    });
    await pass(20);
    const during = [web.count(PAGE) - before, textOf(container)];
    await settle(() => {
      if (saves(web).length === 0) throw new Error('not saved');
    });
    assert({
      given: 'SWR asked to revalidate the page, then a newer copy written into it, while the viewer has unsaved text',
      should: 'fetch nothing, keep the viewer’s text, and save it against the revision the editor knew',
      actual: [during, saves(web)[0]?.body],
      expected: [[0, 'Mine'], { content: '<p>Mine</p>', expectedRevision: 3 }],
    });
  });

  test('a newer copy landing in SWR while the viewer is not editing', async () => {
    const { container } = show({ [RIGHTS]: rights(false) });
    await settle(() => {
      if (textOf(container) !== 'Stored') throw new Error('not open');
    });
    const editorNode = bodyOf(container);
    await act(async () => {
      await swr.mutate?.(
        '/api/pages/notes',
        (current: unknown) => ({ ...(current as object), content: '<p>Revalidated</p>', revision: 4 }),
        { revalidate: false },
      );
    });
    await settle(() => {
      if (textOf(container) !== 'Revalidated') throw new Error('not drawn');
    });
    assert({
      given: 'a newer revision of the page revalidated into SWR',
      should: 'draw its content in the same editor, not a new one',
      actual: bodyOf(container) === editorNode,
      expected: true,
    });
  });
});

describe('editing the title', () => {
  test('renames the page and updates the tree', async () => {
    const { container, web } = show({});
    await editable(container);
    await settle(() => {
      if (!treeTitles.current.includes('Notes')) throw new Error('no tree');
    });
    const field = focusTitle(container);
    const treeBefore = web.count(TREE);
    typeInto(field, '  Launch notes ');
    press(field, 'Enter');
    const treeAtOnce = [...treeTitles.current];
    await settle(() => {
      if (saves(web).length === 0 || web.count(TREE) === treeBefore) throw new Error('not renamed');
    });
    await settle(() => {
      if (!treeTitles.current.includes('Launch notes')) throw new Error('tree not updated');
    });
    assert({
      given: 'a new title typed and committed with Enter',
      should:
        'rename the page through the page route, show the new name in the tree at once and in the header, then refetch the tree',
      actual: {
        sent: saves(web).map((request) => request.body),
        treeAtOnce,
        stored: stored.title,
        current: container.querySelector('nav[aria-label="Page path"] [aria-current="page"]')?.textContent,
        field: field.value,
      },
      expected: {
        sent: [{ title: 'Launch notes', expectedRevision: 3 }],
        treeAtOnce: ['Brief', 'Launch notes'],
        stored: 'Launch notes',
        current: 'Launch notes',
        field: 'Launch notes',
      },
    });
  });

  test('Escape and an empty title', async () => {
    const { container, web } = show({});
    await editable(container);
    const field = focusTitle(container);
    typeInto(field, 'Something else');
    press(field, 'Escape');
    const afterEscape = field.value;
    focusTitle(container);
    typeInto(field, '   ');
    blur(field);
    await pass(50);
    assert({
      given: 'a title edit cancelled with Escape, then a blank title left',
      should: 'put the title back each time and rename nothing',
      actual: [afterEscape, field.value, saves(web).length],
      expected: ['Notes', 'Notes', 0],
    });
  });

  test('a rename and typing share one revision line', async () => {
    const { container, web } = show({});
    await editable(container);
    await type(container, '<p>Body</p>');
    const field = focusTitle(container);
    typeInto(field, 'Plan');
    press(field, 'Enter');
    await type(container, '<p>Body, more</p>');
    await settle(() => {
      if (saves(web).length < 2) throw new Error('not saved');
    });
    assert({
      given: 'a rename while body text waits, then more typing',
      should: 'save the waiting text with the title, then the rest against the next revision, with no conflict',
      actual: [saves(web).map((request) => request.body), container.querySelector('[data-save-conflict]')],
      expected: [
        [
          { content: '<p>Body</p>', title: 'Plan', expectedRevision: 3 },
          { content: '<p>Body, more</p>', expectedRevision: 4 },
        ],
        null,
      ],
    });
  });
});

describe('leaving with text the server does not have', () => {
  /** The viewer opens another page, then comes back to this one. */
  const leaveAndReturn = async (routes: Record<string, FakeRoute>, whileAway: () => void = () => {}) => {
    unmountAll();
    await settle(() => {
      if (documentDraftOf(getUiState(), 'notes') === undefined) throw new Error('no draft kept');
    });
    const kept = documentDraftOf(getUiState(), 'notes');
    whileAway();
    const back = show(routes);
    await settle(() => {
      if (textOf(back.container) !== 'Mine') throw new Error('draft not restored');
    });
    return { kept, ...back };
  };

  test('in a conflict', async () => {
    const { container } = show({});
    await editable(container);
    stored.content = '<p>Theirs</p>';
    stored.revision = 4;
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-conflict]')) throw new Error('no conflict');
    });
    const back = await leaveAndReturn({});
    await settle(() => {
      if (!back.container.querySelector('[data-save-conflict]')) throw new Error('conflict not surfaced again');
    });
    assert({
      given: 'a conflict notice the viewer leaves by opening another page, then comes back',
      should: 'keep their text as a draft, restore it into the editor, and surface the conflict again',
      actual: {
        kept: back.kept,
        text: textOf(back.container),
        restored: back.container.querySelector('[data-draft-restored]')?.textContent,
        stored: stored.content,
        draftLeft: documentDraftOf(getUiState(), 'notes'),
      },
      expected: {
        kept: { patch: { content: '<p>Mine</p>' }, revision: 3 },
        text: 'Mine',
        restored: DRAFT_RESTORED_NOTICE,
        stored: '<p>Theirs</p>',
        draftLeft: undefined,
      },
    });
  });

  test('after a failed save', async () => {
    let failing = true;
    const routes: Record<string, FakeRoute> = {
      [SAVE]: (request) =>
        failing ? Response.json({ error: 'Failed to update page' }, { status: 500 }) : savePage(request),
    };
    const { container } = show(routes);
    await editable(container);
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-failed]')) throw new Error('not failed');
    });
    // The last save as it closes fails too; the server answers again only once the viewer is away.
    const back = await leaveAndReturn(routes, () => {
      failing = false;
    });
    await settle(() => {
      if (stored.content !== '<p>Mine</p>') throw new Error('not saved');
    });
    await pass(20);
    assert({
      given: 'a failed save the viewer leaves, then comes back once the server answers again',
      should: 'restore the text, save it, and stop saying the changes are back once they are saved',
      actual: [
        back.kept,
        stored.content,
        saves(back.web).map((request) => request.body),
        back.container.querySelector('[data-draft-restored]'),
      ],
      expected: [
        { patch: { content: '<p>Mine</p>' }, revision: 3 },
        '<p>Mine</p>',
        [{ content: '<p>Mine</p>', expectedRevision: 3 }],
        null,
      ],
    });
  });

  test('after edit rights were refused', async () => {
    const routes: Record<string, FakeRoute> = {
      [SAVE]: () => Response.json({ error: 'You need edit permission to modify this page' }, { status: 403 }),
    };
    const { container } = show(routes);
    await editable(container);
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-refused]')) throw new Error('not refused');
    });
    const back = await leaveAndReturn(routes);
    await settle(() => {
      if (!back.container.querySelector('[data-save-refused]')) throw new Error('not refused again');
    });
    assert({
      given: 'a refused save the viewer leaves, then comes back',
      should: 'still show their text, read-only, with the refusal, so it can be copied',
      actual: [textOf(back.container), bodyOf(back.container)?.getAttribute('contenteditable')],
      expected: ['Mine', 'false'],
    });
  });

  test('a document closed saved keeps no draft', async () => {
    const { container } = show({});
    await editable(container);
    await type(container, '<p>Mine</p>');
    unmountAll();
    await settle(() => {
      if (stored.content !== '<p>Mine</p>') throw new Error('not saved');
    });
    await pass(20);
    assert({
      given: 'text saved as the document closed',
      should: 'keep no draft',
      actual: documentDraftOf(getUiState(), 'notes'),
      expected: undefined,
    });
  });
});

describe('a CSRF rejection on save', () => {
  test('is a session failure the viewer can retry, not lost rights', async () => {
    let rejecting = true;
    const { container, web } = show({
      [SAVE]: (request) =>
        rejecting
          ? Response.json({ error: 'CSRF token invalid', code: 'CSRF_TOKEN_INVALID' }, { status: 403 })
          : savePage(request),
    });
    await editable(container);
    await type(container, '<p>Mine</p>');
    await settle(() => {
      if (!container.querySelector('[data-save-failed]')) throw new Error('not failed');
    });
    const shown = [
      container.querySelector('[data-save-failed] p')?.textContent,
      container.querySelector('[data-save-refused]'),
      bodyOf(container)?.getAttribute('contenteditable'),
      saves(web).length,
    ];
    rejecting = false;
    click(container.querySelector('[data-save-failed] button') as HTMLButtonElement);
    await settle(() => {
      if (stored.content !== '<p>Mine</p>') throw new Error('not saved');
    });
    assert({
      given: 'a save whose CSRF token is refused even after the client fetched a new one, then Try again',
      should: 'say the session could not be confirmed, stay editable, and save on retry',
      actual: shown,
      expected: [
        'Your session could not be confirmed. Your text is kept here: try again, or reload the page.',
        null,
        'true',
        2,
      ],
    });
  });
});

describe('leaving the tab', () => {
  test('the window losing focus, and the page being hidden', async () => {
    const counts: number[] = [];
    for (const event of ['blur', 'pagehide']) {
      const { container, web } = show({});
      await editable(container);
      await type(container, `<p>${event}</p>`);
      await act(() => {
        window.dispatchEvent(new Event(event));
      });
      await settle(() => {
        if (saves(web).length === 0) throw new Error(`${event}: not sent`);
      }, DOCUMENT_SAVE_DELAY_MS / 2);
      counts.push(saves(web).length);
      unmountAll();
      await pass(20);
    }
    assert({
      given: 'text typed, then the window blurred or the page hidden before the pause',
      should: 'save it at once each time',
      actual: counts,
      expected: [1, 1],
    });
  });

  test('closing the tab with unsaved text', async () => {
    const { container } = show({});
    await editable(container);
    const ask = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const clean = ask();
    await type(container, '<p>Mine</p>');
    const dirty = ask();
    await settle(() => {
      if (container.querySelector('[data-save-state]')?.getAttribute('data-save-state') !== 'saved') throw new Error('not saved');
    });
    assert({
      given: 'the tab closing with nothing unsaved, with unsaved text, then once it saved',
      should: 'ask the browser to warn only while text is unsaved',
      actual: [clean, dirty, ask()],
      expected: [false, true, false],
    });
  });
});

describe('edit rights', () => {
  test('only a definite yes', async () => {
    const actual: unknown[] = [];
    for (const answer of [{}, { canEdit: 'yes' }, { canEdit: 1 }]) {
      const { container, web } = show({ [RIGHTS]: () => Response.json(answer) });
      await settle(() => {
        if (web.count(RIGHTS) === 0 || !textOf(container)) throw new Error('not asked yet');
      });
      await pass(30);
      actual.push(bodyOf(container)?.getAttribute('contenteditable'));
      unmountAll();
    }
    assert({
      given: 'a rights answer with no canEdit, or one that is not the boolean true',
      should: 'keep the document read-only',
      actual,
      expected: ['false', 'false', 'false'],
    });
  });
});

describe('reloadsOn()', () => {
  const page = { pageId: 'notes', ownSocketId: 'sock-me' };
  test('which content events reload the document', () => {
    assert({
      given: 'content events for this page from another tab, from this tab, for another page, and while editing',
      should: 'reload only for another tab’s save while the viewer holds nothing unsaved',
      actual: [
        reloadsOn({ pageId: 'notes', socketId: 'sock-other' }, { ...page, editing: false }),
        reloadsOn({ pageId: 'notes' }, { ...page, editing: false }),
        reloadsOn({ pageId: 'notes', socketId: 'sock-me' }, { ...page, editing: false }),
        reloadsOn({ pageId: 'other', socketId: 'sock-other' }, { ...page, editing: false }),
        reloadsOn({ pageId: 'notes', socketId: 'sock-other' }, { ...page, editing: true }),
        reloadsOn(null, { ...page, editing: false }),
      ],
      expected: [true, true, false, false, false, false],
    });
  });
});

describe('a closing save that answers after the page reopened', () => {
  test('does not lift the reopened document’s pause', async () => {
    let release: () => void = () => {};
    let first = true;
    const routes: Record<string, FakeRoute> = {
      [SAVE]: (request) => {
        if (!first) return savePage(request);
        first = false;
        return new Promise<Response>((resolve) => {
          release = () => resolve(savePage(request) as Response);
        });
      },
    };
    const { container } = show(routes);
    await editable(container);
    await type(container, '<p>Leaving</p>');
    unmountAll();
    // The closing save is still out when the viewer opens the page again and types.
    const back = show(routes);
    await editable(back.container);
    await type(back.container, '<p>Back again</p>');
    const before = isEditingDocument(getUiState(), 'notes');
    await act(async () => {
      release();
    });
    await pass(30);
    assert({
      given: 'a document closed with its save still out, reopened and typed in before that save answered',
      should: 'keep SWR held off the reopened document when the old save finally lands',
      actual: [before, isEditingDocument(getUiState(), 'notes')],
      expected: [true, true],
    });
  });
});
