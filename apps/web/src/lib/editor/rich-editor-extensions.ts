import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Placeholder, CharacterCount } from '@tiptap/extensions';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import { PageMention } from '@/lib/editor/tiptap-mention-config';
import { PaginationPlus } from '@/lib/editor/pagination';
import { CodeBlockShiki } from '@/lib/editor/code-block';
import { FontFormatting } from '@/lib/editor/font-formatting';
import { FindExtension } from '@/lib/editor/find-plugin';

export interface RichEditorExtensionOptions {
  readOnly: boolean;
  isPaginated: boolean;
}

/**
 * The extension list `RichEditor` mounts, and therefore the ProseMirror schema
 * every stored DOCUMENT is parsed and serialized against.
 *
 * Extracted from RichEditor.tsx so a non-React caller can build the same
 * schema. The collab content census (apps/web/scripts/collab-content-census.ts)
 * is the first such caller: it needs to measure what THIS list drops, and a
 * copy of the array in the script would measure a schema no user ever edits
 * against. `packages/editor`'s `collabExtensions()` will supersede this.
 *
 * Note for whoever adds an extension here: `RichEditor` is also the
 * task-description editor (TaskDetailSheet.tsx, TaskListDescription.tsx,
 * TaskDocumentRow.tsx), so this list is shared by surfaces that are never
 * Y.Doc-backed.
 */
export function buildRichEditorExtensions({
  readOnly,
  isPaginated,
}: RichEditorExtensionOptions): Extensions {
  return [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
      link: {
        openOnClick: true,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
      },
      codeBlock: false,
    }),
    CodeBlockShiki,
    Markdown,
    ...(readOnly ? [] : [Placeholder.configure({
      placeholder: 'Start writing...',
    })]),
    TextStyleKit,
    FontFormatting,
    TableKit,
    CharacterCount,
    PageMention,
    FindExtension,
    // Conditionally add pagination based on isPaginated flag
    ...(isPaginated ? [
      PaginationPlus.configure({
        pageHeight: 1056, // US Letter height: 11" × 96 DPI
        pageWidth: 816,   // US Letter width: 8.5" × 96 DPI
        marginTop: 96,    // 1 inch
        marginBottom: 96, // 1 inch
        marginLeft: 96,   // 1 inch
        marginRight: 96,  // 1 inch
        pageGap: 50,      // Gap between pages
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
    ] : []),
  ];
}
