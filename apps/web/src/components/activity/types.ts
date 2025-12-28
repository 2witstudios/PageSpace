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
  changeGroupId: string | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  rollbackFromActivityId: string | null;
  rollbackSourceOperation: string | null;
  rollbackSourceTimestamp: string | null;
  rollbackSourceTitle: string | null;
  user: ActivityUser | null;
}

// Activity grouping types
export type ActivityGroupType = 'rollback' | 'ai_stream' | 'edit_session';

export interface ActivityGroupSummary {
  label: string;
  actorName: string;
  actorImage: string | null;
  timestamp: string;
}

export interface ActivityGroup {
  type: ActivityGroupType;
  id: string;
  activities: ActivityLog[];
  summary: ActivityGroupSummary;
}

export interface SingleActivity {
  type: 'single';
  activity: ActivityLog;
}

export type ActivityDisplayItem = ActivityGroup | SingleActivity;

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
