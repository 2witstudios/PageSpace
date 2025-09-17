import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GridViewProps } from './types';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib';

export function GridView({ items }: GridViewProps) {
  const params = useParams();
  const driveId = params.driveId as string;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
      {items.map((child) => (
        <Link key={child.id} href={`/dashboard/${driveId}/${child.id}`}>
          <div className="flex flex-col items-center justify-center p-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors aspect-square">
            <PageTypeIcon type={child.type as PageType} className="h-10 w-10 mb-2" />
            <span className="text-sm font-medium text-center truncate w-full">
              {child.title}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}