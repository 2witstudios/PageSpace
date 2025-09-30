"use client";

import { Editor } from '@tiptap/react';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, Pilcrow, List, ListOrdered, Quote
} from 'lucide-react';
import React from 'react';
import TableMenu from './TableMenu';

interface ToolbarProps {
  editor: Editor | null;
}

const Toolbar = ({ editor }: ToolbarProps) => {
  if (!editor) {
    return null;
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