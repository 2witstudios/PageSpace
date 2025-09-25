import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { ListViewProps, SortKey } from './types';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/client-safe';
import { toTitleCase } from '@/lib/formatters';

export function ListView({ items, sortKey, sortDirection, onSort }: ListViewProps) {
  const params = useParams();
  const driveId = params.driveId as string;

  const renderHeader = (key: SortKey, title: string, className?: string) => (
    <TableHead className={className}>
      <Button variant="ghost" onClick={() => onSort(key)} className="px-2 py-1 h-auto">
        {title}
        {sortKey === key && (
          <ArrowUpDown
            className={`ml-2 h-4 w-4 transition-transform ${
              sortDirection === 'desc' ? 'rotate-180' : ''
            }`}
          />
        )}
      </Button>
    </TableHead>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50px]"></TableHead>
          {renderHeader('title', 'Name')}
          {renderHeader('type', 'Type', 'w-[120px]')}
          {renderHeader('updatedAt', 'Last Modified', 'w-[150px]')}
          {renderHeader('createdAt', 'Created', 'w-[150px]')}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((child) => (
          <TableRow key={child.id} className="cursor-pointer">
            <TableCell>
              <Link href={`/dashboard/${driveId}/${child.id}`} className="flex items-center">
                <PageTypeIcon type={child.type as PageType} className="h-5 w-5" />
              </Link>
            </TableCell>
            <TableCell>
              <Link href={`/dashboard/${driveId}/${child.id}`} className="block w-full">
                {child.title}
              </Link>
            </TableCell>
            <TableCell>
              <Link href={`/dashboard/${driveId}/${child.id}`} className="block w-full text-sm text-gray-500">
                {toTitleCase(child.type)}
              </Link>
            </TableCell>
            <TableCell>
              <Link href={`/dashboard/${driveId}/${child.id}`} className="block w-full text-sm text-gray-500">
                {new Date(child.updatedAt).toLocaleDateString()}
              </Link>
            </TableCell>
            <TableCell>
              <Link href={`/dashboard/${driveId}/${child.id}`} className="block w-full text-sm text-gray-500">
                {new Date(child.createdAt).toLocaleDateString()}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}