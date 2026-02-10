"use client";

import { Editor } from '@tiptap/react';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, Pilcrow, List, ListOrdered, Quote
} from 'lucide-react';
import React from 'react';
import TableMenu from './TableMenu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ToolbarProps {
  editor: Editor | null;
  contentMode?: 'html' | 'markdown';
}

const FONT_FAMILY_OPTIONS = [
  { value: 'default', label: 'Default', fontFamily: null },
  { value: 'sans', label: 'Sans', fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { value: 'serif', label: 'Serif', fontFamily: 'ui-serif, Georgia, Cambria, "Times New Roman", serif' },
  { value: 'mono', label: 'Mono', fontFamily: 'var(--font-geist-mono), SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' },
] as const;

const FONT_SIZE_OPTIONS = [
  { value: 'default', label: 'Default', fontSize: null },
  { value: '12', label: '12', fontSize: '12px' },
  { value: '14', label: '14', fontSize: '14px' },
  { value: '16', label: '16', fontSize: '16px' },
  { value: '18', label: '18', fontSize: '18px' },
  { value: '20', label: '20', fontSize: '20px' },
  { value: '24', label: '24', fontSize: '24px' },
  { value: '32', label: '32', fontSize: '32px' },
] as const;

type FontFamilyValue = (typeof FONT_FAMILY_OPTIONS)[number]['value'];
type FontSizeValue = (typeof FONT_SIZE_OPTIONS)[number]['value'];

interface TextStyleAttributes {
  fontFamily?: string | null;
  fontSize?: string | null;
}

const normalizeCssValue = (value: string | null | undefined): string => {
  if (!value) {
    return '';
  }

  return value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim().toLowerCase();
};

const getTextStyleAttributes = (editor: Editor): TextStyleAttributes => {
  return editor.getAttributes('textStyle') as TextStyleAttributes;
};

const getSelectedFontFamily = (editor: Editor): FontFamilyValue => {
  const currentFontFamily = normalizeCssValue(getTextStyleAttributes(editor).fontFamily);

  const matchedOption = FONT_FAMILY_OPTIONS.find((option) => {
    if (!option.fontFamily) {
      return false;
    }

    return normalizeCssValue(option.fontFamily) === currentFontFamily;
  });

  return matchedOption?.value ?? 'default';
};

const getSelectedFontSize = (editor: Editor): FontSizeValue => {
  const currentFontSize = normalizeCssValue(getTextStyleAttributes(editor).fontSize);

  const matchedOption = FONT_SIZE_OPTIONS.find((option) => {
    if (!option.fontSize) {
      return false;
    }

    return normalizeCssValue(option.fontSize) === currentFontSize;
  });

  return matchedOption?.value ?? 'default';
};

const isFontFamilyValue = (value: string): value is FontFamilyValue => {
  return FONT_FAMILY_OPTIONS.some((option) => option.value === value);
};

const isFontSizeValue = (value: string): value is FontSizeValue => {
  return FONT_SIZE_OPTIONS.some((option) => option.value === value);
};

const Toolbar = ({ editor, contentMode = 'html' }: ToolbarProps) => {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!editor) {
      return;
    }

    const rerender = () => {
      setTick((prev) => prev + 1);
    };

    editor.on('selectionUpdate', rerender);
    editor.on('transaction', rerender);

    return () => {
      editor.off('selectionUpdate', rerender);
      editor.off('transaction', rerender);
    };
  }, [editor]);

  if (!editor) {
    return null;
  }

  const selectedFontFamily = getSelectedFontFamily(editor);
  const selectedFontSize = getSelectedFontSize(editor);
  const showFontControls = contentMode !== 'markdown';

  const handleFontFamilyChange = (value: string) => {
    if (!isFontFamilyValue(value)) {
      return;
    }

    const option = FONT_FAMILY_OPTIONS.find((item) => item.value === value);
    if (!option) {
      return;
    }

    editor
      .chain()
      .focus()
      .setMark('textStyle', { fontFamily: option.fontFamily })
      .removeEmptyTextStyle()
      .run();
  };

  const handleFontSizeChange = (value: string) => {
    if (!isFontSizeValue(value)) {
      return;
    }

    const option = FONT_SIZE_OPTIONS.find((item) => item.value === value);
    if (!option) {
      return;
    }

    editor
      .chain()
      .focus()
      .setMark('textStyle', { fontSize: option.fontSize })
      .removeEmptyTextStyle()
      .run();
  };

  return (
    <div className="w-full overflow-x-auto scrollbar-thin">
      <div className="flex items-center gap-1 p-2 min-w-max">
        {showFontControls && (
          <>
            <Select value={selectedFontFamily} onValueChange={handleFontFamilyChange}>
              <SelectTrigger className="h-8 w-[130px] text-xs" aria-label="Font family">
                <SelectValue placeholder="Font" />
              </SelectTrigger>
              <SelectContent>
                {FONT_FAMILY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span style={option.fontFamily ? { fontFamily: option.fontFamily } : undefined}>
                      {option.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedFontSize} onValueChange={handleFontSizeChange}>
              <SelectTrigger className="h-8 w-[96px] text-xs" aria-label="Font size">
                <SelectValue placeholder="Size" />
              </SelectTrigger>
              <SelectContent>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span style={option.fontSize ? { fontSize: option.fontSize } : undefined}>
                      {option.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="w-[1px] h-6 bg-border mx-1" />
          </>
        )}
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('bold') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Bold size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('italic') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Italic size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleStrike().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('strike') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Strikethrough size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleCode().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('code') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Code size={16} /></button>
        <div className="w-[1px] h-6 bg-border mx-1" />
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`p-2 rounded-md transition-colors ${editor.isActive('heading', { level: 1 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading1 size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={`p-2 rounded-md transition-colors ${editor.isActive('heading', { level: 2 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading2 size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={`p-2 rounded-md transition-colors ${editor.isActive('heading', { level: 3 }) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Heading3 size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().setParagraph().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('paragraph') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Pilcrow size={16} /></button>
        <div className="w-[1px] h-6 bg-border mx-1" />
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBulletList().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('bulletList') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><List size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('orderedList') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><ListOrdered size={16} /></button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`p-2 rounded-md transition-colors ${editor.isActive('blockquote') ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Quote size={16} /></button>
        <div className="w-[1px] h-6 bg-border mx-1" />
        <TableMenu editor={editor} />
      </div>
    </div>
  );
};

export default Toolbar;
