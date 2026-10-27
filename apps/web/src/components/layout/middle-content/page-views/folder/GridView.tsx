import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GridViewProps } from './types';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/utils/enums';
import { cn } from '@/lib/utils';

export function GridView({ items, findMatchSet, currentFindId }: GridViewProps) {
  const params = useParams();
  const driveId = params.driveId as string;

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1">
      {items.map((child) => (
        <Link key={child.id} href={`/dashboard/${driveId}/${child.id}`}>
          <div
            data-item-id={child.id}
            className={cn(
              'flex flex-col items-center gap-1.5 pt-2 pb-1.5 px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer',
              findMatchSet?.has(child.id) && 'find-highlight',
              currentFindId === child.id && 'find-highlight-current',
            )}
          >
            <PageTypeIcon type={child.type as PageType} className="h-12 w-12 shrink-0" />
            <span className="text-xs text-center line-clamp-2 w-full leading-tight break-words">
              {child.title}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}