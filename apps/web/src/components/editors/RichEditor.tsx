"use client";

import { useEditor, EditorContent, Editor } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import React, { useCallback, useEffect, useRef } from 'react';
import { Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, Pilcrow, List, ListOrdered, Quote } from 'lucide-react';
import { Placeholder, CharacterCount } from '@tiptap/extensions';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import { formatHtml } from '@/lib/editor/prettier';
import { PageMention } from '@/lib/editor/tiptap-mention-config';
import { PaginationPlus, PAGE_SIZES, getMarginPreset } from '@/lib/editor/pagination';

interface RichEditorProps {
  value: string;
  onChange: (value: string) => void;
  onFormatChange?: (value: string) => void;
  onEditorChange: (editor: Editor | null) => void;
  onEditorDomChange?: (element: HTMLElement | null) => void;
  readOnly?: boolean;
  isPaginated?: boolean;
  pageSize?: string;
  margins?: string;
  showPageNumbers?: boolean;
  showHeaders?: boolean;
  showFooters?: boolean;
}

const RichEditor = ({
  value,
  onChange,
  onFormatChange,
  onEditorChange,
  onEditorDomChange,
  readOnly = false,
  isPaginated = false,
  pageSize = 'letter',
  margins = 'normal',
  showPageNumbers = true,
  showHeaders = false,
  showFooters = false
}: RichEditorProps) => {
  // Formatting timer - CRITICAL for AI editability (2500ms)
  // Prettier formats HTML so AI can reliably edit structured content
  // Uses silent update via onFormatChange to avoid marking as dirty
  const formatTimeout = useRef<NodeJS.Timeout | null>(null);
  const formatVersion = useRef(0);

  const debouncedFormat = useCallback(
    (editor: Editor) => {
      if (formatTimeout.current) {
        clearTimeout(formatTimeout.current);
      }
      // Increment version - invalidates any in-flight formatting
      formatVersion.current++;

      formatTimeout.current = setTimeout(async () => {
        const currentVersion = formatVersion.current;
        const html = editor.getHTML();
        const formattedHtml = await formatHtml(html);

        // Only update editor if no new typing and formatting actually changed content
        if (currentVersion === formatVersion.current && formattedHtml !== html) {
          // Use silent update to avoid marking as dirty and triggering save
          if (onFormatChange) {
            onFormatChange(formattedHtml);
          } else {
            onChange(formattedHtml); // Fallback for backward compatibility
          }
        }
      }, 2500); // Give Prettier time to format without disrupting typing
    },
    [onChange, onFormatChange]
  );

  // Compute pagination configuration from props
  // This ensures editor initializes with correct database values
  const pageSizeConfig = isPaginated ? PAGE_SIZES[pageSize.toUpperCase() as keyof typeof PAGE_SIZES] : null;
  const marginPreset = isPaginated ? getMarginPreset(margins) : null;
  const computedFooterRight = showPageNumbers ? 'Page {page}' : '';
  const computedHeaderHeight = showHeaders ? 30 : 0;
  const computedFooterHeight = (showFooters || showPageNumbers) ? 30 : 0;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
        link: {
          openOnClick: true,
        },
      }),
      Markdown,
      ...(readOnly ? [] : [Placeholder.configure({
        placeholder: 'Start writing...',
      })]),
      TextStyleKit,
      TableKit,
      CharacterCount,
      PageMention,
      // Conditionally add pagination based on isPaginated flag
      // Use computed values from props instead of hardcoded defaults
      ...(isPaginated && pageSizeConfig && marginPreset ? [
        PaginationPlus.configure({
          pageHeight: pageSizeConfig.pageHeight,
          pageWidth: pageSizeConfig.pageWidth,
          marginTop: marginPreset.top,
          marginBottom: marginPreset.bottom,
          marginLeft: marginPreset.left,
          marginRight: marginPreset.right,
          pageGap: 50,      // Gap between pages
          pageHeaderHeight: computedHeaderHeight,
          pageFooterHeight: computedFooterHeight,
          footerRight: computedFooterRight,
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
    ],
    content: value,
    editable: !readOnly,
    autofocus: readOnly ? false : undefined,
    onUpdate: ({ editor }) => {
      if (!readOnly) {
        // Immediate update - just report the change
        const html = editor.getHTML();
        onChange(html);

        // Debounced formatting (optional, cosmetic only)
        debouncedFormat(editor);
      }
    },
    editorProps: {
      attributes: {
        class: readOnly
          ? 'tiptap m-5 cursor-text'
          : 'tiptap m-5 focus:outline-none',
        tabindex: readOnly ? '-1' : '0',
        style: readOnly ? 'user-select: text; -webkit-user-select: text;' : '',
      },
      scrollThreshold: 80,
      scrollMargin: 80,
    },
  }, [isPaginated, pageSize, margins, showPageNumbers, showHeaders, showFooters]); // Recreate when pagination settings change

  useEffect(() => {
    if (editor) {
      const currentHTML = editor.getHTML();
      // Check if value is empty and current HTML is just the default empty paragraph
      const isEmptyValue = !value || value.trim() === '';
      const isDefaultEmptyHTML = currentHTML === '<p></p>' || 
                                 currentHTML === '<p><br></p>' || 
                                 currentHTML === '<p><br/></p>' ||
                                 currentHTML === '<p><br /></p>';
      
      // Only update if there's a meaningful difference
      if (isEmptyValue && isDefaultEmptyHTML) {
        // Both are effectively empty, no need to update
        return;
      }
      
      if (value !== currentHTML) {
        // Save current view state before updating content
        const { from, to } = editor.state.selection;
        // Get current selection position
        
        // Get the current view's scroll position if available
        const editorElement = editor.view.dom;
        const scrollTop = editorElement?.parentElement?.scrollTop || 0;
        
        // Update content
        editor.commands.setContent(value || '', { emitUpdate: false });
        
        // Restore selection and scroll position after content update
        requestAnimationFrame(() => {
          if (editor && !editor.isDestroyed) {
            try {
              // Calculate the actual position accounting for any added line breaks
              // Tiptap's positions include text nodes + block boundaries
              const docSize = editor.state.doc.content.size;
              
              // For same-line cursor preservation, we need to account for block boundaries
              // Each block (paragraph) adds 1 to the position count
              let adjustedFrom = from;
              let adjustedTo = to;
              
              // If we're at the end of a paragraph, stay there
              const resolvedPos = editor.state.doc.resolve(Math.min(from, docSize - 1));
              const isAtBlockEnd = resolvedPos.node().type.name === 'paragraph' && 
                                   resolvedPos.parentOffset === resolvedPos.parent.content.size;
              
              if (!isAtBlockEnd) {
                // Normal position within text
                adjustedFrom = Math.min(from, docSize - 1);
                adjustedTo = Math.min(to, docSize - 1);
              } else {
                // At block boundary - preserve exact position
                adjustedFrom = Math.min(from, docSize);
                adjustedTo = Math.min(to, docSize);
              }
              
              editor.commands.setTextSelection({
                from: adjustedFrom,
                to: adjustedTo
              });
              
              // Restore scroll position
              if (editorElement?.parentElement) {
                editorElement.parentElement.scrollTop = scrollTop;
              }
            } catch (error) {
              console.debug('Could not restore cursor position:', error);
            }
          }
        });
      }
    }
  }, [value, editor]);

  useEffect(() => {
    onEditorChange(editor);
    // Blur the editor if it's read-only to prevent focus
    if (editor && readOnly) {
      editor.commands.blur();
    }
    return () => {
      onEditorChange(null);
    };
  }, [editor, onEditorChange, readOnly]);

  // Expose editor DOM element for print handler
  useEffect(() => {
    if (editor && onEditorDomChange) {
      const editorElement = editor.view.dom as HTMLElement;
      onEditorDomChange(editorElement);
      return () => {
        onEditorDomChange(null);
      };
    }
  }, [editor, onEditorDomChange]);

  return (
    <div className="relative flex flex-col w-full h-full">
      {editor && !readOnly && (
        <BubbleMenu
          editor={editor}
          pluginKey="bubbleMenu"
          shouldShow={({ from, to }) => {
            // show the bubble menu when the user selects some text
            return from !== to;
          }}
          className="flex items-center gap-1 p-2 border rounded-md bg-card shadow-lg"
        >
          <button onClick={() => editor.chain().focus().toggleBold().run()} className={`p-2 rounded ${editor.isActive('bold') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Bold size={16} /></button>
          <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-2 rounded ${editor.isActive('italic') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Italic size={16} /></button>
          <button onClick={() => editor.chain().focus().toggleStrike().run()} className={`p-2 rounded ${editor.isActive('strike') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Strikethrough size={16} /></button>
          <button onClick={() => editor.chain().focus().toggleCode().run()} className={`p-2 rounded ${editor.isActive('code') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Code size={16} /></button>
          <div className="w-[1px] h-6 bg-muted-foreground/50 mx-2" />
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`p-2 rounded ${editor.isActive('heading', { level: 1 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading1 size={16} /></button>
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={`p-2 rounded ${editor.isActive('heading', { level: 2 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading2 size={16} /></button>
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={`p-2 rounded ${editor.isActive('heading', { level: 3 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading3 size={16} /></button>
        </BubbleMenu>
      )}
      {editor && !readOnly && (
        <FloatingMenu
          editor={editor}
          pluginKey="floatingMenu"
          shouldShow={({ editor, from }) => {
            // show the floating menu when the user types `/`
            return editor.state.doc.textBetween(from - 1, from) === '/';
          }}
          className="flex flex-col gap-1 p-2 border rounded-md bg-card shadow-lg"
        >
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('heading', { level: 1 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading1 size={16} /><span>Heading 1</span></button>
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('heading', { level: 2 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading2 size={16} /><span>Heading 2</span></button>
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('heading', { level: 3 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading3 size={16} /><span>Heading 3</span></button>
          <button onClick={() => editor.chain().focus().setParagraph().run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('paragraph') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Pilcrow size={16} /><span>Paragraph</span></button>
          <div className="w-full h-[1px] bg-muted-foreground/50 my-1" />
          <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('bulletList') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><List size={16} /><span>Bullet List</span></button>
          <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('orderedList') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><ListOrdered size={16} /><span>Ordered List</span></button>
          <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`flex items-center gap-2 p-2 rounded ${editor.isActive('blockquote') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Quote size={16} /><span>Quote</span></button>
        </FloatingMenu>
      )}
      <div className={`flex-1 overflow-y-auto ${readOnly ? 'opacity-95' : ''}`}>
        <EditorContent editor={editor} />
      </div>
      <div className="flex justify-end p-2 text-sm text-muted-foreground">
        {editor?.storage.characterCount.characters()} characters
      </div>
    </div>
  );
};

export default RichEditor;