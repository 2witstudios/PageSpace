export type { EventTrigger } from '@pagespace/db';

/** JSON-serialized workflow from the API (dates are strings, not Date objects). */
export interface Workflow {
  id: string;
  driveId: string;
  createdBy: string;
  name: string;
  agentPageId: string;
  prompt: string;
  contextPageIds: string[];
  triggerType: 'cron' | 'event';
  cronExpression: string | null;
  timezone: string;
  isEnabled: boolean;
  eventTriggers?: EventTrigger[] | null;
  watchedFolderIds?: string[] | null;
  eventDebounceSecs?: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: 'never_run' | 'success' | 'error' | 'running';
  lastRunError: string | null;
  lastRunDurationMs: number | null;
  createdAt: string;
  updatedAt: string;
}
