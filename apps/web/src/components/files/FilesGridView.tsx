'use client';

import { useRouter } from 'next/navigation';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { FileItemContextMenu } from './FileItemContextMenu';
import { PageType } from '@pagespace/lib/client-safe';
import type { TreePage } from '@/hooks/usePageTree';

interface FilesGridViewProps {
  items: TreePage[];
  driveId: string;
  onMutate: () => void;
}

export function FilesGridView({ items, driveId, onMutate }: FilesGridViewProps) {
  const router = useRouter();

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-1">
      {items.map((item) => (
        <FileItemContextMenu key={item.id} item={item} driveId={driveId} onMutate={onMutate}>
          <div
            className="flex flex-col items-center gap-1.5 pt-2 pb-1.5 px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
            onClick={() => router.push(`/dashboard/${driveId}/files/${item.id}`)}
          >
            <PageTypeIcon type={item.type as PageType} className="h-12 w-12 shrink-0" />
            <span className="text-xs text-center line-clamp-2 w-full leading-tight break-words">
              {item.title}
            </span>
          </div>
        </FileItemContextMenu>
      ))}
    </div>
  );
}
