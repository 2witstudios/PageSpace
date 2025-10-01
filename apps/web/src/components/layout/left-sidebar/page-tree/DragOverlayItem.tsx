"use client";

import { TreePage } from "../../../../hooks/usePageTree";
import { GripVertical } from "lucide-react";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import { PageType } from '@pagespace/lib/client-safe';

interface DragOverlayItemProps {
  node: TreePage;
}

export default function DragOverlayItem({ node }: DragOverlayItemProps) {
  const hasChildren = node.children && node.children.length > 0;
  
  return (
    <div className="flex items-center px-3 py-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 opacity-90">
      <GripVertical className="h-4 w-4 text-gray-400 mr-2" />
      <PageTypeIcon
        type={node.type as PageType}
        className={`
          h-4 w-4 mr-2
          ${hasChildren ? 'text-primary' : 'text-gray-500'}
        `}
      />
      <span className="text-sm font-medium">{node.title}</span>
    </div>
  );
}