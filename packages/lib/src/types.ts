import { PageType, PermissionAction } from './enums';

export interface Page {
  id: string;
  title: string;
  type: PageType;
  content: any;
  position: number;
  isTrashed: boolean;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
  driveId: string;
  parentId: string | null;
  originalParentId: string | null;
  isOwned?: boolean;
  accessLevel?: PermissionAction | null;
}

export interface Drive {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  isTrashed: boolean;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isOwned: boolean;
}