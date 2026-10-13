"use client";

import { Editor } from '@tiptap/react';
import {
  Bold, Italic, Strikethrough, Code, List, ListOrdered, Quote
} from 'lucide-react';
import React from 'react';
import TableMenu from './TableMenu';
import LinkButton from './LinkButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/retained/components/ui/select';

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

/** One labelled formatting button; `aria-pressed` carries the active mark (the board's Bold [pressed]). */
const FormatButton = ({ label, active, onClick, children }: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`h-8 w-8 flex items-center justify-center rounded-md transition-colors ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
  >
    {children}
  </button>
);

const BLOCK_TYPE_OPTIONS = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'heading1', label: 'Heading 1' },
  { value: 'heading2', label: 'Heading 2' },
  { value: 'heading3', label: 'Heading 3' },
] as const;

type BlockTypeValue = (typeof BLOCK_TYPE_OPTIONS)[number]['value'];

const isBlockTypeValue = (value: string): value is BlockTypeValue => {
  return BLOCK_TYPE_OPTIONS.some((option) => option.value === value);
};

/** The block the selection sits in, as the block-type dropdown names it. */
export const blockTypeOf = (editor: Editor): BlockTypeValue => {
  if (editor.isActive('heading', { level: 1 })) return 'heading1';
  if (editor.isActive('heading', { level: 2 })) return 'heading2';
  if (editor.isActive('heading', { level: 3 })) return 'heading3';
  return 'paragraph';
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

  if (!editor || editor.isDestroyed) {
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

  const handleBlockTypeChange = (value: string) => {
    if (!isBlockTypeValue(value)) {
      return;
    }

    const chain = editor.chain().focus();
    switch (value) {
      case 'heading1':
        chain.toggleHeading({ level: 1 }).run();
        return;
      case 'heading2':
        chain.toggleHeading({ level: 2 }).run();
        return;
      case 'heading3':
        chain.toggleHeading({ level: 3 }).run();
        return;
      case 'paragraph':
        chain.setParagraph().run();
        return;
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
      <div className="flex items-center gap-1 min-w-max">
        <Select value={blockTypeOf(editor)} onValueChange={(value) => handleBlockTypeChange(value)}>
          <SelectTrigger className="h-8 w-[120px] text-xs" aria-label="Block type">
            <SelectValue placeholder="Paragraph" />
          </SelectTrigger>
          <SelectContent>
            {BLOCK_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="w-[1px] h-6 bg-border mx-1" />
        <FormatButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></FormatButton>
        <FormatButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></FormatButton>
        <FormatButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></FormatButton>
        <FormatButton label="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={16} /></FormatButton>
        <LinkButton editor={editor} variant="toolbar" />
        <div className="w-[1px] h-6 bg-border mx-1" />
        <FormatButton label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={16} /></FormatButton>
        <FormatButton label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></FormatButton>
        <FormatButton label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={16} /></FormatButton>
        <div className="w-[1px] h-6 bg-border mx-1" />
        <TableMenu editor={editor} />
        {showFontControls && (
          <>
            <div className="ml-auto" />
            <div className="w-[1px] h-6 bg-border mx-1" />
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
          </>
        )}
      </div>
    </div>
  );
};

export default Toolbar;
