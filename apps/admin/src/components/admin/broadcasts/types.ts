import type { BroadcastActionInput, BroadcastCreateInput } from '@/lib/broadcasts/schema';

export type BroadcastStatus =
  | 'draft'
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * True once a broadcast has reached a settled state — polling stops here.
 *
 * `failed` is deliberately EXCLUDED: the worker writes `failed` and rethrows
 * on a retryable per-recipient/provider failure so pg-boss retries the job,
 * meaning a `failed` row can resume sending and later reach `in_progress` or
 * `completed`. Mirrors `INTERVENTION_BLOCKED_STATES` in
 * `app/api/admin/broadcasts/[id]/route.ts`, which likewise never blocks a
 * cancel on `failed` for the same reason.
 */
export const TERMINAL_STATUSES: readonly BroadcastStatus[] = ['completed', 'cancelled'];

export function isTerminalStatus(status: BroadcastStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface BroadcastListItem {
  id: string;
  subject: string;
  status: BroadcastStatus;
  engine: 'transactional' | 'resend_broadcast';
  dryRun: boolean;
  totalTargeted: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: string;
}

export interface BroadcastsListResponse {
  broadcasts: BroadcastListItem[];
}

export interface BroadcastStepResult {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  at: string;
}

export interface BroadcastDetail {
  id: string;
  subject: string;
  status: BroadcastStatus;
  engine: 'transactional' | 'resend_broadcast';
  contentMode: 'compose' | 'template';
  dryRun: boolean;
  sendLimit: number | null;
  delayMs: number | null;
  totalTargeted: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  stepResults: BroadcastStepResult[];
  attempts: number;
  lastError: string | null;
  blockedReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BroadcastTemplate {
  id: string;
  name: string;
  subject: string;
  bodyMarkdown: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastTemplatesResponse {
  templates: BroadcastTemplate[];
}

export interface BroadcastDryRunResponse {
  dryRun: true;
  audienceCount: number;
  previewHtml: string;
  subject: string;
}

export interface BroadcastCreateAcceptedResponse {
  broadcastId: string;
  jobId: string | null;
  enqueue: 'confirmed' | 'unconfirmed';
}

export interface BroadcastCreateConflictResponse {
  error: string;
  duplicateOf: string;
}

export interface BroadcastCreateFailedResponse {
  error: string;
  broadcastId: string;
}

export interface BroadcastValidationErrorResponse {
  error: string;
  details?: Record<string, string[] | undefined>;
}

export type { BroadcastActionInput, BroadcastCreateInput };
