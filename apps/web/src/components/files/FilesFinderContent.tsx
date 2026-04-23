'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Grip, List, Plus } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { usePageTree } from '@/hooks/usePageTree';
import { useDriveStore } from '@/hooks/useDrive';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import CreatePageDialog from '@/components/layout/left-sidebar/CreatePageDialog';
import { FilesBreadcrumbs } from './FilesBreadcrumbs';
import { FilesGridView } from './FilesGridView';
import { FilesListView } from './FilesListView';
import { FilesEmptyState } from './FilesEmptyState';
import type { ViewMode, SortKey, SortDirection } from '@/components/layout/middle-content/page-views/folder/types';

interface FilesFinderContentProps {
  driveId: string;
  currentPageId: string | null;
}

export function FilesFinderContent({ driveId, currentPageId }: FilesFinderContentProps) {
  const { tree, isLoading, mutate } = usePageTree(driveId);
  const drives = useDriveStore((state) => state.drives);
  const drive = drives.find((d) => d.id === driveId);
  const driveName = drive?.name ?? 'Files';
  const canWrite = drive?.role === 'OWNER' || drive?.role === 'ADMIN';

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  // Determine which items to display
  const { items, notFound } = useMemo(() => {
    if (!currentPageId) {
      return { items: tree, notFound: false };
    }

    const result = findNodeAndParent(tree, currentPageId);
    if (!result) {
      return { items: [], notFound: true };
    }

    return { items: result.node.children ?? [], notFound: false };
  }, [tree, currentPageId]);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aValue = a[sortKey];
      const bValue = b[sortKey];

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [items, sortKey, sortDirection]);

  const handleMutate = () => {
    mutate();
  };

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-96" />
          </div>
        </div>
      </div>
    );
  }

  if (notFound && currentPageId) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground mb-4">Page not found in this drive.</p>
            <Link
              href={`/dashboard/${driveId}/files`}
              className="text-primary hover:underline"
            >
              Back to root
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="min-w-0 flex-1">
            {currentPageId ? (
              <FilesBreadcrumbs
                driveId={driveId}
                driveName={driveName}
                currentPageId={currentPageId}
                tree={tree}
              />
            ) : (
              <h1 className="text-2xl font-bold truncate">{driveName}</h1>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant={viewMode === 'list' ? 'secondary' : 'ghost'} size="icon" onClick={() => setViewMode('list')}>
              <List className="h-4 w-4" />
            </Button>
            <Button variant={viewMode === 'grid' ? 'secondary' : 'ghost'} size="icon" onClick={() => setViewMode('grid')}>
              <Grip className="h-4 w-4" />
            </Button>
            {canWrite && (
              <Button size="sm" onClick={() => setIsDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                New Page
              </Button>
            )}
          </div>
        </div>

        {sortedItems.length === 0 ? (
          <FilesEmptyState
            driveId={driveId}
            parentId={currentPageId}
            canWrite={canWrite}
            onMutate={handleMutate}
          />
        ) : viewMode === 'grid' ? (
          <FilesGridView items={sortedItems} driveId={driveId} onMutate={handleMutate} />
        ) : (
          <FilesListView
            items={sortedItems}
            driveId={driveId}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            onMutate={handleMutate}
          />
        )}
      </div>
      {canWrite && (
        <CreatePageDialog
          driveId={driveId}
          parentId={currentPageId}
          isOpen={isDialogOpen}
          setIsOpen={setIsDialogOpen}
          onPageCreated={() => {
            handleMutate();
            setIsDialogOpen(false);
          }}
        />
      )}
    </div>
  );
}
