import { TreePage } from '@/hooks/usePageTree';

export type ViewMode = 'grid' | 'list';

export type SortKey = 'title' | 'updatedAt' | 'createdAt' | 'type';

export type SortDirection = 'asc' | 'desc';

export interface DriveViewProps {
  pages: TreePage[];
}

export interface GridViewProps {
  items: TreePage[];
}

export interface ListViewProps {
  items: TreePage[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
}