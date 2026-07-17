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
 * True once a broadcast is in a state the admin API will always refuse to
 * intervene on further — mirrors `INTERVENTION_BLOCKED_STATES` in
 * `app/api/admin/broadcasts/[id]/route.ts` exactly. `failed` is deliberately
 * EXCLUDED: cancelling a `failed` row is always accepted server-side (it may
 * be mid pg-boss-retry backoff, or a dead row an admin just wants to close
 * out), so Cancel must stay offered for every status except these two.
 */
export const TERMINAL_STATUSES: readonly BroadcastStatus[] = ['completed', 'cancelled'];

export function isTerminalStatus(status: BroadcastStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * True once NOTHING will ever change this row again, for the purpose of
 * deciding whether the progress page should keep polling.
 *
 * This is a strictly narrower and separate question from `isTerminalStatus`
 * (which governs cancellability): `completed`/`cancelled` are always settled;
 * a `failed` row is settled ONLY when `blockedReason` is set. That's
 * `refuse()` in `apps/processor/src/workers/email-broadcast-worker.ts` — an
 * on-prem live-send block, unresolvable content, or an unreachable CTA link —
 * which RETURNS (never rethrows), so pg-boss will never retry that job.
 *
 * A `failed` row with `blockedReason` null is ambiguous by the row's fields
 * alone: it's either a retryable per-recipient/ledger failure mid pg-boss
 * backoff (WILL change), or a pre-enqueue failure (`markFailed` in
 * `broadcast-repository.ts`, hit before any job existed) or a retry-exhausted
 * job (WILL NOT change) — nothing in the frozen `GET .../[id]` response
 * distinguishes those two. Polling keeps running rather than risk freezing on
 * a row that's still actually retrying; Cancel (`isTerminalStatus`) stays
 * available the whole time so an admin who notices a dead row can close it
 * out explicitly, which — being `cancelled` — does stop polling.
 */
export function isPollingSettled(status: BroadcastStatus, blockedReason: string | null): boolean {
  if (isTerminalStatus(status)) return true;
  return status === 'failed' && blockedReason != null;
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
