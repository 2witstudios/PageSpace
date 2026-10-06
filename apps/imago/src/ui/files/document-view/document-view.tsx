'use client';

// A DOCUMENT page opened as the Files object. Its content is the stored HTML
// (or markdown) from GET /api/pages/[pageId], parsed by TipTap into
// @pagespace/editor's document schema and drawn by ProseMirror, so nothing
// reaches the page as raw HTML. Its path comes from the drive tree the files
// pane already holds, so the header names only pages the viewer can see.
//
// When the server says the viewer may edit it, the content and the title are
// edited in place and saved through classic's own route (PATCH
// /api/pages/[pageId]) the way classic's DocumentView saves: debounced while
// typing, at once on blur, rename, leaving the page or the tab, and always
// against the revision the editor last knew. Text the server does not have
// yet is never replaced: SWR is held off the page meanwhile (the files
// slice's editingDocuments, imago's useEditingStore), and someone else's
// save reloads the document only when the viewer holds nothing unsaved.

import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@/api/errors';
import { useApiClient } from '@/api/swr-provider';
import { useSocketEvent, useSocketId } from '@/realtime/realtime-provider';
import { dispatch, transactions } from '../../store/transactions';
import { fileHref } from '../create-file/create-file';
import {
  fetchStoredDocument,
  saveDocument,
  useCanEdit,
  type StoredDocument,
} from '../document-edit/document-api';
import { documentTitleInputClass } from '../document-edit/document-edit-class';
import { renderDocumentNotice, renderDraftRestored } from '../document-edit/document-notice.render';
import { createDocumentSaver, type SaverState } from '../document-edit/document-saver';
import type { FileNode } from '../file-model/file-node';
import { documentDraftOf } from '../files-plugin/files-plugin';
import { getUiState } from '../../store/store';
import { usePage } from '../page-object/page-object';
import { onlyListed, pathTo } from '../tree-view/tree-view';
import { useFileTree } from '../use-file-tree/use-file-tree';
import { readerExtensions } from './document-prose';
import { documentBodyClass } from './document-view-class';
import { renderDocumentView, type DocumentCrumb } from './document-view.render';

/** What the view reads of a page from GET /api/pages/[pageId]. */
export type DocumentPage = {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  /** The stored revision the content is; saves are made against it. */
  readonly revision: number;
  /** How the content is stored, and so how an edit is written back. */
  readonly contentMode: 'html' | 'markdown';
};

export type DocumentViewProps = {
  readonly driveId: string;
  readonly page: DocumentPage;
};

const UNTITLED = 'Untitled';

const OFFLINE = 'Could not reach PageSpace. Try again.';

/** The pages above this one in the tree the viewer is shown; none until it loads or when it is not there. */
export const crumbsFor = (
  nodes: readonly FileNode[] | undefined,
  listedIds: ReadonlySet<string>,
  pageId: string,
): readonly DocumentCrumb[] => {
  if (nodes === undefined) return [];
  const path = pathTo(onlyListed(nodes, listedIds), pageId) ?? [];
  return path.slice(0, -1).map((node) => ({ id: node.id, title: node.name }));
};

type MarkdownStorage = { readonly markdown?: { readonly getMarkdown?: () => string } };

/** The editor's document as the page stores it (classic's RichEditor serializeEditorContent). */
export const serializeDocument = (editor: Editor, contentMode: DocumentPage['contentMode']): string =>
  contentMode === 'markdown'
    ? ((editor.storage as unknown as MarkdownStorage).markdown?.getMarkdown?.() ?? '')
    : editor.getHTML();

/** The ProseMirror root's attributes: a textbox while it can be edited, marked read-only otherwise. */
const bodyAttributes = (title: string, editable: boolean): Record<string, string> => ({
  class: documentBodyClass,
  'aria-label': `${title} content`,
  'data-document-body': '',
  ...(editable ? { role: 'textbox', 'aria-multiline': 'true' } : { 'aria-readonly': 'true' }),
});

/**
 * Whether a `page:content-updated` event reloads the document: someone
 * else's save (not one this tab's socket made) of this page, while the
 * viewer holds nothing unsaved.
 */
export const reloadsOn = (
  payload: unknown,
  { pageId, ownSocketId, editing }: { readonly pageId: string; readonly ownSocketId: string | undefined; readonly editing: boolean },
): boolean => {
  if (typeof payload !== 'object' || payload === null) return false;
  const { pageId: named, socketId } = payload as { pageId?: unknown; socketId?: unknown };
  if (named !== pageId) return false;
  if (typeof socketId === 'string' && socketId === ownSocketId) return false;
  return !editing;
};

const shownTitleOf = (title: string): string => (title.trim() === '' ? UNTITLED : title);

const SAVED: SaverState = { status: { kind: 'saved' }, editing: false };

/**
 * How long a closed document's last save may hold SWR off its page. The API
 * client sets no timeout, so a save that never answers would otherwise keep
 * the page paused for the rest of the tab.
 */
export const CLOSING_SAVE_TIMEOUT_MS = 15_000;

export function DocumentView({ driveId, page }: DocumentViewProps): ReactNode {
  const router = useRouter();
  // The editor is made once; a mention click reads the router it has now.
  const routerRef = useRef(router);
  routerRef.current = router;
  const navigate = useCallback((href: string) => routerRef.current.push(href), []);

  const client = useApiClient();
  const socketId = useSocketId();
  const { mutate: mutatePage } = usePage(page.id);
  const { nodes, listedIds, rename: renameInTree, retry: revalidateTree } = useFileTree(driveId);
  const canEdit = useCanEdit(page.id);

  // The stored copy the editor last matched: newer revisions from SWR replace it, older never do.
  const known = useRef<StoredDocument>({ revision: page.revision, title: page.title, content: page.content });
  const [title, setTitle] = useState(page.title);
  const [titleDraft, setTitleDraft] = useState(page.title);
  const [saveState, setSaveState] = useState<SaverState>(SAVED);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  // This view's own claim on the page's pause: a closing view's late save ends only its own.
  const viewId = useId();

  /**
   * The page's SWR entry takes a stored copy, without asking the server
   * again. Best effort: a save that landed stays saved even when the cache is
   * already gone (the document closed with the app around it).
   */
  const storeInCache = useCallback(
    (stored: StoredDocument) => {
      mutatePage(
        (current: unknown) => (typeof current === 'object' && current !== null ? { ...current, ...stored } : current),
        { revalidate: false },
      ).catch(() => {
        // No cache to keep current.
      });
    },
    [mutatePage],
  );

  const opened = useRef(page.revision);
  const saver = useMemo(
    () =>
      createDocumentSaver({
        revision: opened.current,
        send: async (patch, expectedRevision) => {
          const stored = await saveDocument(client, page.id, patch, expectedRevision, socketId());
          known.current = stored;
          // The entry holds what was saved, so no older copy is drawn from it later.
          storeInCache(stored);
          return stored;
        },
        onState: (state) => {
          setSaveState(state);
          // Restored changes that are saved (or set aside for the stored copy) need no more saying.
          if (state.status.kind === 'saved') setDraftRestored(false);
        },
      }),
    [client, page.id, socketId, storeInCache],
  );

  const editable = canEdit && saveState.status.kind !== 'read-only';
  const shownTitle = shownTitleOf(title);

  const editor = useEditor(
    {
      extensions: readerExtensions({ navigate }),
      content: page.content,
      editable: false,
      immediatelyRender: false,
      // The stylesheet TipTap would inject has no CSP nonce; the classes carry what it needs.
      injectCSS: false,
      editorProps: { attributes: bodyAttributes(shownTitleOf(page.title), false) },
      // Content set while read-only, or from the server, is not the viewer's to save.
      onUpdate: ({ editor: changed }) => {
        if (changed.isEditable) saver.edit(serializeDocument(changed, page.contentMode));
      },
      onBlur: () => {
        void saver.flush();
      },
    },
    [navigate, saver, page.contentMode],
  );

  useEffect(() => {
    if (editor === null) return;
    editor.setEditable(editable, false);
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: bodyAttributes(shownTitle, editable) } });
  }, [editor, editable, shownTitle]);

  // Unsaved text holds SWR off the page (and is what a reload must not replace).
  useEffect(() => {
    dispatch(saveState.editing ? transactions.beginDocumentEdit : transactions.endDocumentEdit, {
      pageId: page.id,
      viewId,
    });
  }, [saveState.editing, page.id, viewId]);

  // Leaving the document saves what is waiting. Text that still did not
  // reach the server (a conflict, a refusal, a failure) is never dropped with
  // the view: it is kept as the page's draft and restored when it opens again.
  // Then SWR has the page again: once the save answers, or once it has had
  // CLOSING_SAVE_TIMEOUT_MS, whichever comes first.
  useEffect(
    () => () => {
      const release = () => dispatch(transactions.endDocumentEdit, { pageId: page.id, viewId });
      const timeout = setTimeout(release, CLOSING_SAVE_TIMEOUT_MS);
      void saver.flush().finally(() => {
        clearTimeout(timeout);
        const unsaved = saver.unsaved();
        if (unsaved !== null) {
          dispatch(transactions.keepDocumentDraft, {
            pageId: page.id,
            draft: { patch: unsaved, revision: saver.revision() },
          });
        }
        release();
      });
    },
    [saver, page.id, viewId],
  );

  // A document that closed with unsaved text opens with it again, and saves
  // it against the revision it was made on: a conflict or refusal surfaces anew.
  const draftTaken = useRef(false);
  useEffect(() => {
    if (editor === null || draftTaken.current) return;
    draftTaken.current = true;
    const draft = documentDraftOf(getUiState(), page.id);
    if (draft === undefined) return;
    dispatch(transactions.dropDocumentDraft, page.id);
    const { content, title: draftTitle } = draft.patch;
    if (content !== undefined) editor.commands.setContent(content, { emitUpdate: false });
    if (draftTitle !== undefined) {
      setTitle(draftTitle);
      setTitleDraft(draftTitle);
    }
    saver.restore(draft.patch, draft.revision);
    setDraftRestored(true);
  }, [editor, saver, page.id]);

  // Leaving the tab saves too; closing it with text the server lacks asks first.
  useEffect(() => {
    const flush = () => {
      void saver.flush();
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (saver.isEditing() || saver.unsaved() !== null) event.preventDefault();
    };
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', warn);
    };
  }, [saver]);

  /** The editor shows `stored` now, as the server has it. */
  const adopt = useCallback(
    (stored: StoredDocument) => {
      known.current = stored;
      saver.adopt(stored.revision);
      editor?.commands.setContent(stored.content, { emitUpdate: false });
      setTitle(stored.title);
      setTitleDraft(stored.title);
    },
    [editor, saver],
  );

  // A newer stored copy (SWR revalidated, or someone else's save reloaded)
  // replaces what is shown, unless the viewer holds unsaved text.
  useEffect(() => {
    if (editor === null || saver.isEditing() || page.revision <= known.current.revision) return;
    adopt({ revision: page.revision, title: page.title, content: page.content });
  }, [editor, saver, adopt, page.revision, page.title, page.content]);

  // Someone else saved this page: reload it, unless the viewer is editing.
  // The editing check is the first of three layers (with SWR's pause and the
  // revision guard above) and the only one that asks nothing of the server.
  useSocketEvent('page:content-updated', (payload: unknown) => {
    if (reloadsOn(payload, { pageId: page.id, ownSocketId: socketId(), editing: saver.isEditing() })) void mutatePage();
  });

  const resolve = async (settle: (stored: StoredDocument) => Promise<unknown> | void) => {
    setResolveError(null);
    try {
      await settle(await fetchStoredDocument(client, page.id));
    } catch (error) {
      setResolveError(error instanceof ApiError ? error.message : OFFLINE);
    }
  };
  const keepMine = () => void resolve((stored) => saver.keepMine(stored.revision));
  const takeStored = () =>
    void resolve((stored) => {
      adopt(stored);
      storeInCache(stored);
    });

  // A title is committed on Enter or leaving the field; Escape puts it back.
  const titleCancelled = useRef(false);
  const commitTitle = async (value: string) => {
    const next = value.trim();
    if (titleCancelled.current || next === '' || next === title) {
      titleCancelled.current = false;
      setTitleDraft(title);
      return;
    }
    setTitle(next);
    setTitleDraft(next);
    renameInTree(page.id, next);
    await saver.rename(next);
    revalidateTree();
  };

  const heading = editable ? (
    <input
      aria-label="Title"
      className={documentTitleInputClass}
      placeholder={UNTITLED}
      value={titleDraft}
      onChange={(event) => setTitleDraft(event.target.value)}
      onBlur={(event) => void commitTitle(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          titleCancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  ) : (
    shownTitle
  );

  const crumbs = useMemo(() => crumbsFor(nodes, listedIds, page.id), [nodes, listedIds, page.id]);
  const hrefFor = useCallback((pageId: string) => fileHref(driveId, pageId), [driveId]);

  return renderDocumentView({
    title: shownTitle,
    crumbs,
    hrefFor,
    heading,
    notice: (
      <>
        {draftRestored ? renderDraftRestored() : null}
        {renderDocumentNotice({
      status: saveState.status,
      editable,
      onKeepMine: keepMine,
      onUseStored: takeStored,
          onRetry: () => void saver.flush(),
          resolveError,
        })}
      </>
    ),
    body: <EditorContent editor={editor} />,
  });
}
