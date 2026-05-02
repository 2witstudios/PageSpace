/**
 * JSON-serialized workflow from the API (dates are strings, not Date objects).
 *
 * `lastRun` is a denormalized projection of the most recent workflow_runs row
 * for this workflow. It's null when the workflow has never fired. The cron
 * status badge / last-run column reads from this rather than from columns on
 * the workflow row itself.
 */
export interface WorkflowLastRun {
  status: 'running' | 'success' | 'error' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  durationMs: number | null;
}

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
  nextRunAt: string | null;
  lastRun: WorkflowLastRun | null;
  createdAt: string;
  updatedAt: string;
}
