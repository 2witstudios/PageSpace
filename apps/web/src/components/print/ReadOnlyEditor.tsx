'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { CharacterCount } from '@tiptap/extensions';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import { PageMention } from '@/lib/editor/tiptap-mention-config';
import { useEffect } from 'react';

/**
 * ReadOnlyEditor - Renders Tiptap content without editing capabilities
 *
 * ## Purpose
 * Used in print routes to render ProseMirror JSON with exact same typography
 * as the main editor. This ensures heights, spacing, and formatting match
 * precisely for accurate pagination calculations.
 *
 * ## Extension Parity
 * Uses identical extensions to RichEditor (minus editing-only extensions):
 * - StarterKit (headings, links, lists, etc.)
 * - Markdown support
 * - TextStyleKit (for inline styles)
 * - TableKit (table rendering)
 * - CharacterCount (for metrics)
 * - PageMention (for @page references)
 *
 * ## Excluded Extensions
 * - Placeholder (editing-only)
 * - PaginationPlus (print route handles pagination differently)
 * - BubbleMenu/FloatingMenu (editing UI)
 */

interface ReadOnlyEditorProps {
  content: string;
  className?: string;
  onMount?: (element: HTMLElement | null) => void;
}

export default function ReadOnlyEditor({
  content,
  className = '',
  onMount
}: ReadOnlyEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
        link: {
          openOnClick: false, // Disable link clicks in print view
        },
      }),
      Markdown,
      TextStyleKit,
      TableKit,
      CharacterCount,
      PageMention,
    ],
    content,
    editable: false, // CRITICAL: Disable all editing
    editorProps: {
      attributes: {
        class: 'tiptap',
        tabindex: '-1', // Remove from tab order
        style: 'user-select: text; -webkit-user-select: text;', // Allow text selection for print
      },
    },
  });

  // Expose editor DOM element to parent
  useEffect(() => {
    if (editor && onMount) {
      const editorElement = editor.view.dom as HTMLElement;
      onMount(editorElement);
      return () => {
        onMount(null);
      };
    }
  }, [editor, onMount]);

  // Update content when prop changes
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

  return (
    <div className={`read-only-editor ${className}`}>
      <EditorContent editor={editor} />
    </div>
  );
}
