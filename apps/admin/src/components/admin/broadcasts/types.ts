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

/** True once a broadcast has reached a settled state — polling stops here. */
export const TERMINAL_STATUSES: readonly BroadcastStatus[] = ['completed', 'failed', 'cancelled'];

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
