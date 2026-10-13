"use client";

import { Editor } from '@tiptap/react';
import { Table } from 'lucide-react';
import React from 'react';

interface TableMenuProps {
  editor: Editor;
}

const TableMenu = ({ editor }: TableMenuProps) => {
  return (
    <div className="flex items-center gap-1">
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        className="p-2 rounded hover:bg-muted"
      >
        <Table size={16} />
      </button>
    </div>
  );
};

export default TableMenu;