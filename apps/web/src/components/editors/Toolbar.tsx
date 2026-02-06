"use client";

import { Editor } from '@tiptap/react';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, Pilcrow, List, ListOrdered, Quote, Table, Type
} from 'lucide-react';
import React, { useState } from 'react';
import TableMenu from './TableMenu';
import { useMobile } from '@/hooks/useMobile';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

interface ToolbarProps {
  editor: Editor | null;
}

interface FormatButtonProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onPress: () => void;
}

function MobileFormatButton({ icon, label, isActive, onPress }: FormatButtonProps) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        'flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm transition-colors active:bg-accent',
        isActive ? 'bg-primary/10 text-primary' : ''
      )}
    >
      <span className={cn(
        'flex items-center justify-center h-8 w-8 rounded-md',
        isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
      )}>
        {icon}
      </span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

const Toolbar = ({ editor }: ToolbarProps) => {
  const isMobile = useMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!editor) {
    return null;
  }

  if (isMobile) {
    return (
      <>
        <div className="flex items-center justify-center p-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setSheetOpen(true)}
          >
            <Type className="h-4 w-4" />
            <span className="text-xs">Format</span>
          </Button>
        </div>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl max-h-[70vh] pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="px-5 pt-3 pb-0">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
              <SheetTitle className="text-base">Format</SheetTitle>
              <SheetDescription className="sr-only">Text formatting options</SheetDescription>
            </SheetHeader>

            <div className="overflow-y-auto px-5 pb-4 mt-2">
              <div className="mb-4">
                <p className="text-xs font-medium text-muted-foreground mb-2 px-3">Text Style</p>
                <div className="space-y-0.5">
                  <MobileFormatButton icon={<Bold size={16} />} label="Bold" isActive={editor.isActive('bold')} onPress={() => editor.chain().focus().toggleBold().run()} />
                  <MobileFormatButton icon={<Italic size={16} />} label="Italic" isActive={editor.isActive('italic')} onPress={() => editor.chain().focus().toggleItalic().run()} />
                  <MobileFormatButton icon={<Strikethrough size={16} />} label="Strikethrough" isActive={editor.isActive('strike')} onPress={() => editor.chain().focus().toggleStrike().run()} />
                  <MobileFormatButton icon={<Code size={16} />} label="Inline Code" isActive={editor.isActive('code')} onPress={() => editor.chain().focus().toggleCode().run()} />
                </div>
              </div>

              <div className="mb-4">
                <p className="text-xs font-medium text-muted-foreground mb-2 px-3">Headings</p>
                <div className="space-y-0.5">
                  <MobileFormatButton icon={<Heading1 size={16} />} label="Heading 1" isActive={editor.isActive('heading', { level: 1 })} onPress={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
                  <MobileFormatButton icon={<Heading2 size={16} />} label="Heading 2" isActive={editor.isActive('heading', { level: 2 })} onPress={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
                  <MobileFormatButton icon={<Heading3 size={16} />} label="Heading 3" isActive={editor.isActive('heading', { level: 3 })} onPress={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
                  <MobileFormatButton icon={<Pilcrow size={16} />} label="Paragraph" isActive={editor.isActive('paragraph')} onPress={() => editor.chain().focus().setParagraph().run()} />
                </div>
              </div>

              <div className="mb-4">
                <p className="text-xs font-medium text-muted-foreground mb-2 px-3">Lists & Blocks</p>
                <div className="space-y-0.5">
                  <MobileFormatButton icon={<List size={16} />} label="Bullet List" isActive={editor.isActive('bulletList')} onPress={() => editor.chain().focus().toggleBulletList().run()} />
                  <MobileFormatButton icon={<ListOrdered size={16} />} label="Numbered List" isActive={editor.isActive('orderedList')} onPress={() => editor.chain().focus().toggleOrderedList().run()} />
                  <MobileFormatButton icon={<Quote size={16} />} label="Quote" isActive={editor.isActive('blockquote')} onPress={() => editor.chain().focus().toggleBlockquote().run()} />
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 px-3">Insert</p>
                <div className="space-y-0.5">
                  <MobileFormatButton
                    icon={<Table size={16} />}
                    label="Table"
                    isActive={false}
                    onPress={() => {
                      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
                      setSheetOpen(false);
                    }}
                  />
                </div>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <div className="w-full overflow-x-auto scrollbar-thin">
      <div className="flex items-center gap-1 p-2 min-w-max">
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
