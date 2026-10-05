import type { WorkflowStep } from './WorkflowStepsEditor';

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
  /** Null once the creator's account is deleted ([D-OW-36]: the workflow is then owner-left). */
  createdBy: string | null;
  name: string;
  /** Null for step-based workflows whose ai steps carry their own agent. */
  agentPageId: string | null;
  prompt: string;
  /** Null = legacy single-AI-prompt workflow; the form synthesizes one ai step. */
  steps: WorkflowStep[] | null;
  contextPageIds: string[];
  triggerType: 'cron';
  cronExpression: string | null;
  timezone: string;
  isEnabled: boolean;
  /** [D-OW-36] Set when the creator left the org or deleted their account: disabled until an Owner or Admin reassigns or deletes it. */
  ownerLeftAt: string | null;
  nextRunAt: string | null;
  lastRun: WorkflowLastRun | null;
  createdAt: string;
  updatedAt: string;
}
