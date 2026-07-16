/**
 * Shared rollback types.
 *
 * Extracted from rollback-service.ts so the pure modules can depend on the
 * ActivityLogForRollback shape without importing back through the service shell.
 * The public barrel re-exports these unchanged.
 */
import type { ActivityResourceType, ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';
import type { ChangeGroupType } from '@pagespace/lib/monitoring/change-group';
import type { PageContentFormat } from '@pagespace/lib/content/page-content-format';

/**
 * Activity log with full details for rollback
 */
export interface ActivityLogForRollback {
  id: string;
  timestamp: Date;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  operation: string;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  contentSnapshot: string | null;
  contentRef: string | null;
  contentFormat: PageContentFormat | null;
  contentSize: number | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  streamId: string | null;
  streamSeq: number | null;
  changeGroupId: string | null;
  changeGroupType: ChangeGroupType | null;
  stateHashBefore: string | null;
  stateHashAfter: string | null;
  rollbackFromActivityId: string | null;
  rollbackSourceOperation: ActivityOperation | null;
  rollbackSourceTimestamp: Date | null;
  rollbackSourceTitle: string | null;
}
