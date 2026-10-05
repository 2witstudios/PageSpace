'use client';

// A DOCUMENT page opened as the Files object, read-only. Its content is the
// stored HTML (or markdown) from GET /api/pages/[pageId], parsed by TipTap
// into @pagespace/editor's document schema and drawn by ProseMirror, so
// nothing reaches the page as raw HTML. Its path comes from the drive tree
// the files pane already holds, so the header names only pages the viewer can
// see. Editing is a later leaf (IMG-7.5).

import { EditorContent, useEditor } from '@tiptap/react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { fileHref } from '../create-file/create-file';
import type { FileNode } from '../file-model/file-node';
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
};

export type DocumentViewProps = {
  readonly driveId: string;
  readonly page: DocumentPage;
};

const UNTITLED = 'Untitled';

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

export function DocumentView({ driveId, page }: DocumentViewProps): ReactNode {
  const router = useRouter();
  // The editor is made once; a mention click reads the router it has now.
  const routerRef = useRef(router);
  routerRef.current = router;
  const navigate = useCallback((href: string) => routerRef.current.push(href), []);

  const title = page.title.trim() === '' ? UNTITLED : page.title;
  const editor = useEditor(
    {
      extensions: readerExtensions({ navigate }),
      content: page.content,
      editable: false,
      immediatelyRender: false,
      // The stylesheet TipTap would inject has no CSP nonce; the classes carry what it needs.
      injectCSS: false,
      editorProps: {
        attributes: {
          class: documentBodyClass,
          'aria-label': `${title} content`,
          'aria-readonly': 'true',
          'data-document-body': '',
        },
      },
    },
    [navigate],
  );

  // A newer version of the page (revalidated by SWR) replaces what is shown.
  const shown = useRef(page.content);
  useEffect(() => {
    if (editor === null || shown.current === page.content) return;
    shown.current = page.content;
    editor.commands.setContent(page.content, { emitUpdate: false });
  }, [editor, page.content]);

  const { nodes, listedIds } = useFileTree(driveId);
  const crumbs = useMemo(() => crumbsFor(nodes, listedIds, page.id), [nodes, listedIds, page.id]);
  const hrefFor = useCallback((pageId: string) => fileHref(driveId, pageId), [driveId]);

  return renderDocumentView({ title, crumbs, hrefFor, body: <EditorContent editor={editor} /> });
}
