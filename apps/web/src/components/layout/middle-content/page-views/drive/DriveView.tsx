'use client';

import { useState, useMemo } from 'react';
import { DriveViewProps, ViewMode, SortKey, SortDirection } from './types';
import { DriveViewHeader } from './DriveViewHeader';
import { GridView } from './GridView';
import { ListView } from './ListView';

export default function DriveView({ pages }: DriveViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
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

  const sortedPages = useMemo(() => {
    return [...pages].sort((a, b) => {
      const aValue = a[sortKey];
      const bValue = b[sortKey];

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [pages, sortKey, sortDirection]);

  return (
    <div className="p-4">
      <DriveViewHeader viewMode={viewMode} onViewChange={setViewMode} />
      {viewMode === 'grid' ? (
        <GridView items={sortedPages} />
      ) : (
        <ListView
          items={sortedPages}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={handleSort}
        />
      )}
    </div>
  );
}