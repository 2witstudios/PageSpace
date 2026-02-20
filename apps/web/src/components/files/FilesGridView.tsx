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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
      {items.map((item) => (
        <FileItemContextMenu key={item.id} item={item} driveId={driveId} onMutate={onMutate}>
          <div
            className="flex flex-col items-center justify-center p-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors aspect-square cursor-pointer"
            onClick={() => router.push(`/dashboard/${driveId}/files/${item.id}`)}
          >
            <PageTypeIcon type={item.type as PageType} className="h-10 w-10 mb-2" />
            <span className="text-sm font-medium text-center truncate w-full">
              {item.title}
            </span>
          </div>
        </FileItemContextMenu>
      ))}
    </div>
  );
}
