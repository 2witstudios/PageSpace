/** JSON-serialized workflow from the API (dates are strings, not Date objects). */
export interface Workflow {
  id: string;
  driveId: string;
  createdBy: string;
  name: string;
  agentPageId: string;
  prompt: string;
  contextPageIds: string[];
  triggerType: 'cron';
  cronExpression: string | null;
  timezone: string;
  isEnabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: 'never_run' | 'success' | 'error' | 'running';
  lastRunError: string | null;
  lastRunDurationMs: number | null;
  createdAt: string;
  updatedAt: string;
}
