import type { ElementType } from 'react';

export interface ActivityUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface ActivityLog {
  id: string;
  timestamp: string;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  aiConversationId: string | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  user: ActivityUser | null;
}

export interface Drive {
  id: string;
  name: string;
  slug: string;
}

export interface Actor {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ActivityFilters {
  startDate?: Date;
  endDate?: Date;
  actorId?: string;
  operation?: string;
  resourceType?: string;
  driveId?: string;
}

export interface OperationConfig {
  icon: ElementType;
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
}
