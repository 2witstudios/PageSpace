import { TreePage } from '@/hooks/usePageTree';

export type ViewMode = 'grid' | 'list';

export type SortKey = 'title' | 'updatedAt' | 'createdAt' | 'type';

export type SortDirection = 'asc' | 'desc';

export interface FolderViewProps {
  page: TreePage;
}

export interface GridViewProps {
  items: TreePage[];
  findMatchSet?: Set<string>;
  currentFindId?: string | null;
}

export interface ListViewProps {
  items: TreePage[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  findMatchSet?: Set<string>;
  currentFindId?: string | null;
}