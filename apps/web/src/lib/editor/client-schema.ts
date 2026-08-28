import type { Extensions } from '@tiptap/core';
import type { Doc as YDoc } from 'yjs';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Placeholder, CharacterCount } from '@tiptap/extensions';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { PageMention } from '@/lib/editor/tiptap-mention-config';
import { PaginationPlus } from '@/lib/editor/pagination';
import { CodeBlockShiki } from '@/lib/editor/code-block';
import { FindExtension } from '@/lib/editor/find-plugin';
import { BlockId } from '@/lib/editor/block-id';
import { CommentMark, InsertionMark, DeletionMark } from '@/lib/editor/collab-marks';
import { ImageNode } from '@/lib/editor/image-node';
import { STARTER_KIT_SCHEMA_OPTIONS } from '@/lib/editor/collab-schema';

/**
 * The client's extension set: everything in the frozen schema
 * (`collab-schema.ts`'s `collabExtensions()`) plus view-only additions.
 * Deliberately NOT a re-export of `collabExtensions()` plus a spread —
 * `RichEditor` needs the client variants of `codeBlock`/`pageMention`
 * (`CodeBlockShiki`/`PageMention`, which extend the frozen schema's
 * `CodeBlockNode`/`PageMentionNode`), not the schema-only bases. The drift
 * guard (`collab-schema-drift-guard.test.ts`) asserts this list's projected
 * spec is identical to `collabExtensions()`'s, for both `readOnly` states, so
 * the two lists cannot silently diverge in what they can represent.
 */

export interface CollabOptions {
  /** An initialized Y.Doc — the document this editor instance syncs. */
  document: YDoc;
  /**
   * The collaboration provider (e.g. a Sync/Hocuspocus provider). Untyped
   * here deliberately; `@tiptap/extension-collaboration-caret` accepts any
   * provider shape. Optional: `CollaborationCaret` requires a provider and
   * throws during `onCreate` if configured without one, so `clientExtensions()`
   * only mounts it when this is set — a caller that has a Y.Doc but no
   * provider yet still gets document sync, just no presence carets.
   */
  provider?: unknown;
  user?: { name: string; color: string };
}

export interface ClientExtensionOptions {
  readOnly: boolean;
  isPaginated: boolean;
  /**
   * When set, the client mounts `Collaboration` bound to `collab.document`
   * (plus `CollaborationCaret` too, if `collab.provider` is also set — it
   * requires one), and MUST NOT also receive initial `content` — that would
   * duplicate the whole document alongside the Yjs-synced one. Native
   * undo/redo (`StarterKit`'s `undoRedo`) is force-disabled ONLY in this
   * case: leaving it on with Yjs mounted makes Cmd-Z undo other people's
   * edits, not just your own. Every editor built without `collab` keeps its
   * own undo/redo.
   */
  collab?: CollabOptions;
}

export function clientExtensions({ readOnly, isPaginated, collab }: ClientExtensionOptions): Extensions {
  return [
    StarterKit.configure({
      ...STARTER_KIT_SCHEMA_OPTIONS,
      // Native history fights Yjs's own undo stack, so it's disabled ONLY
      // when collab is mounted: Cmd-Z would otherwise revert other people's
      // edits, not just yours. Every non-collaborative RichEditor (documents
      // without `collab`, and every task-description surface) keeps
      // StarterKit's own undo/redo — force-disabling it unconditionally here
      // silently removed Cmd-Z from all of them.
      ...(collab ? { undoRedo: false } : {}),
    }),
    CodeBlockShiki,
    Markdown,
    ...(readOnly ? [] : [Placeholder.configure({ placeholder: 'Start writing...' })]),
    TextStyleKit,
    TableKit,
    TaskList,
    TaskItem,
    ImageNode,
    Highlight,
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    CharacterCount,
    PageMention,
    FindExtension,
    BlockId,
    CommentMark,
    InsertionMark,
    DeletionMark,
    ...(isPaginated
      ? [
          PaginationPlus.configure({
            pageHeight: 1056, // US Letter height: 11" × 96 DPI
            pageWidth: 816, // US Letter width: 8.5" × 96 DPI
            marginTop: 96, // 1 inch
            marginBottom: 96, // 1 inch
            marginLeft: 96, // 1 inch
            marginRight: 96, // 1 inch
            pageGap: 50, // Gap between pages
            pageHeaderHeight: 30,
            pageFooterHeight: 30,
            footerRight: 'Page {page}',
            footerLeft: '',
            headerRight: '',
            headerLeft: '',
            contentMarginTop: 10,
            contentMarginBottom: 10,
            pageBreakBackground: '#ffffff',
            pageGapBorderColor: '#e5e5e5',
            pageGapBorderSize: 1,
          }),
        ]
      : []),
    ...(collab
      ? [
          Collaboration.configure({ document: collab.document }),
          ...(collab.provider
            ? [
                CollaborationCaret.configure({
                  provider: collab.provider,
                  user: collab.user,
                }),
              ]
            : []),
        ]
      : []),
  ];
}
