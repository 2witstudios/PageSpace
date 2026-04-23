import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GridViewProps } from './types';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/utils/enums';

export function GridView({ items }: GridViewProps) {
  const params = useParams();
  const driveId = params.driveId as string;

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-1">
      {items.map((child) => (
        <Link key={child.id} href={`/dashboard/${driveId}/${child.id}`}>
          <div className="flex flex-col items-center gap-1.5 pt-2 pb-1.5 px-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer">
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