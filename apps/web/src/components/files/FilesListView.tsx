'use client';

import { useRouter } from 'next/navigation';
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
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { FileItemContextMenu } from './FileItemContextMenu';
import { PageType } from '@pagespace/lib/client-safe';
import { toTitleCase } from '@/lib/utils/formatters';
import type { TreePage } from '@/hooks/usePageTree';
import type { SortKey, SortDirection } from '@/components/layout/middle-content/page-views/folder/types';

interface FilesListViewProps {
  items: TreePage[];
  driveId: string;
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  onMutate: () => void;
}

export function FilesListView({ items, driveId, sortKey, sortDirection, onSort, onMutate }: FilesListViewProps) {
  const router = useRouter();

  const handleRowClick = (itemId: string) => {
    router.push(`/dashboard/${driveId}/files/${itemId}`);
  };

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
        {items.map((item) => (
          <FileItemContextMenu key={item.id} item={item} driveId={driveId} onMutate={onMutate}>
            <TableRow
              className="cursor-pointer"
              onClick={() => handleRowClick(item.id)}
            >
              <TableCell>
                <PageTypeIcon type={item.type as PageType} className="h-5 w-5" />
              </TableCell>
              <TableCell>{item.title}</TableCell>
              <TableCell className="text-sm text-gray-500">
                {toTitleCase(item.type)}
              </TableCell>
              <TableCell className="text-sm text-gray-500">
                {new Date(item.updatedAt).toLocaleDateString()}
              </TableCell>
              <TableCell className="text-sm text-gray-500">
                {new Date(item.createdAt).toLocaleDateString()}
              </TableCell>
            </TableRow>
          </FileItemContextMenu>
        ))}
      </TableBody>
    </Table>
  );
}
