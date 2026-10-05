// How imago reads a document: TipTap on @pagespace/editor's document schema,
// exactly as stored content is parsed everywhere else, plus one view-only
// extension. That extension adds no node, mark or attribute: it puts imago's
// token classes on the drawn nodes as decorations and keeps page mentions
// inside imago. Markup the schema does not know (scripts, handler attributes,
// an <img> with a URL, unsafe links) is dropped by the parse, and nothing is
// ever set as raw HTML.

import { Extension, type Extensions } from '@tiptap/core';
import type { Mark, Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { collabExtensions } from '@pagespace/editor/collab-schema';
import { fileHref } from '../create-file/create-file';
import { documentProseClasses as classes } from './document-view-class';

const headingClasses: Readonly<Record<number, string>> = {
  1: classes.h1,
  2: classes.h2,
  3: classes.h3,
};

const nodeClasses: Readonly<Record<string, string>> = {
  bulletList: classes.ul,
  orderedList: classes.ol,
  taskList: classes.taskList,
  taskItem: classes.taskItem,
  blockquote: classes.blockquote,
  codeBlock: classes.codeBlock,
  horizontalRule: classes.hr,
  table: classes.table,
  tableCell: classes.cell,
  tableHeader: classes.headerCell,
  image: classes.image,
  pageMention: classes.mention,
};

const markClasses: Readonly<Record<string, string>> = {
  link: classes.link,
  code: classes.code,
  highlight: classes.highlight,
};

/** The class a document node is drawn with, if imago styles it. */
export const proseClassOf = (node: PmNode): string | undefined => {
  if (node.type.name === 'heading') {
    const level = Number(node.attrs.level);
    return headingClasses[level] ?? classes.h4;
  }
  return nodeClasses[node.type.name];
};

/** The class a run of marked text is drawn with, if imago styles that mark. */
export const markClassOf = (mark: Mark): string | undefined => markClasses[mark.type.name];

/** Every node and marked run of a document as a class decoration. */
export const documentDecorations = (doc: PmNode): DecorationSet => {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const nodeClass = proseClassOf(node);
    if (nodeClass !== undefined) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: nodeClass }));
    if (node.isText) {
      for (const mark of node.marks) {
        const markClass = markClassOf(mark);
        if (markClass !== undefined) decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: markClass }));
      }
    }
  });
  return DecorationSet.create(doc, decorations);
};

/**
 * Where a click on a page mention goes in imago. Stored mentions carry
 * classic's /dashboard href; inside imago the page opens as the object.
 */
export const mentionHrefOf = (target: EventTarget | null): string | null => {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  const anchor = target.closest('a[data-mention-type="page"]');
  const driveId = anchor?.getAttribute('data-drive-id');
  const pageId = anchor?.getAttribute('data-page-id');
  return driveId && pageId ? fileHref(driveId, pageId) : null;
};

export type DocumentProseOptions = {
  /** Opens an imago address (the router's push). */
  readonly navigate: (href: string) => void;
};

const proseKey = new PluginKey<DecorationSet>('imagoDocumentProse');

/** The view-only extension: token classes as decorations, mentions opened in imago. */
export const DocumentProse = Extension.create<DocumentProseOptions>({
  name: 'imagoDocumentProse',

  addOptions() {
    return { navigate: () => {} };
  },

  addProseMirrorPlugins() {
    const { navigate } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: proseKey,
        state: {
          init: (_, state) => documentDecorations(state.doc),
          apply: (tr, previous) => (tr.docChanged ? documentDecorations(tr.doc) : previous),
        },
        props: {
          decorations: (state) => proseKey.getState(state),
          handleDOMEvents: {
            click: (_view, event) => {
              const href = mentionHrefOf(event.target);
              if (href === null) return false;
              event.preventDefault();
              navigate(href);
              return true;
            },
          },
        },
      }),
    ];
  },
});

/** The document schema's extensions, then the reader's view-only one. */
export const readerExtensions = (options: DocumentProseOptions): Extensions => [
  ...collabExtensions(),
  DocumentProse.configure(options),
];
