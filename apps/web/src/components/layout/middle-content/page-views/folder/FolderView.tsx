'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { usePageTree } from '@/hooks/usePageTree';
import { Loader2 } from 'lucide-react';
import { FolderViewProps, ViewMode, SortKey, SortDirection } from './types';
import { FolderViewHeader } from './FolderViewHeader';
import { GridView } from './GridView';
import { ListView } from './ListView';
import { PageType, isFolderPage } from '@pagespace/lib/client-safe';

export default function FolderView({ page }: FolderViewProps) {
  const params = useParams();
  const driveId = params.driveId as string;
  const { fetchAndMergeChildren, childLoadingMap } = usePageTree(driveId);
  const isLoadingChildren = childLoadingMap[page.id];

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  useEffect(() => {
    if (isFolderPage(page.type as PageType) && !page.children) {
      fetchAndMergeChildren(page.id);
    }
  }, [page.id, page.type, page.children, fetchAndMergeChildren]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const sortedChildren = useMemo(() => {
    const children = page.children || [];
    return [...children].sort((a, b) => {
      const aValue = a[sortKey];
      const bValue = b[sortKey];

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [page.children, sortKey, sortDirection]);

  return (
    <div className="p-4">
      <FolderViewHeader viewMode={viewMode} onViewChange={setViewMode} />
      {isLoadingChildren ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-gray-500" />
        </div>
      ) : (
        <>
          {viewMode === 'grid' ? (
            <GridView items={sortedChildren} />
          ) : (
            <ListView
              items={sortedChildren}
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          )}
        </>
      )}
    </div>
  );
}