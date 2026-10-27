'use client';

/**
 * What a local environment is doing RIGHT NOW and what it did — the
 * Cowork property the bridge lacked: you can see it working (GA wave 3,
 * leaf 2). Fed by `useEnvActivity`, which is the server-side grant audit
 * live over the owner's socket room.
 *
 * Rendered ONLY for the machine's OWNER ([D-6]): every row names a command
 * the owner's agent ran on the owner's own computer. The caller decides
 * (the sidebar compares `ownerId` to the viewer; the settings page the same)
 * and passes `enabled` — this component never asks the server on a
 * non-owner's behalf.
 *
 * Two lists, not one with a status column: "Running now" is the whole point
 * of the panel and must never be scrolled away by history. `compact` is the
 * sidebar shape — running rows plus the last few — and the settings page
 * renders the full tail.
 */

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEnvActivity } from '@/hooks/drive-envs/useEnvActivity';
import type { DriveEnvActivityDTO } from '@pagespace/lib/drive-envs/env-contract';

export interface EnvActivityPanelProps {
  driveId: string;
  envId: string;
  /** Owner-only: false mounts nothing and requests nothing. */
  enabled: boolean;
  /** `account`: read through the owner-scoped account route (no drive membership needed). */
  scope?: 'drive' | 'account';
  /** The sidebar shape: running rows plus a short tail. */
  compact?: boolean;
  /** How many settled rows the tail shows (compact: 3; full: 20). */
  tailSize?: number;
  className?: string;
}

/** A verdict as a person reads it. The vocabulary is the audit table's; the words are the owner's. */
export function describeVerdict(row: DriveEnvActivityDTO): { label: string; tone: 'running' | 'ok' | 'refused' | 'pending' | 'failed' } {
  const { verdict, exitCode } = row;
  if (verdict === 'signed') return { label: 'Running', tone: 'running' };
  if (verdict === 'completed') return exitCode === null || exitCode === 0 ? { label: 'Done', tone: 'ok' } : { label: `Exit ${exitCode}`, tone: 'failed' };
  if (verdict === 'completed:write_failed') return { label: 'Write failed', tone: 'failed' };
  if (verdict.startsWith('ask_pending:')) return { label: 'Waiting for your approval', tone: 'pending' };
  if (verdict.startsWith('denied:')) return { label: `Machine refused (${verdict.slice('denied:'.length)})`, tone: 'refused' };
  if (verdict.startsWith('refused:')) return { label: `PageSpace refused (${verdict.slice('refused:'.length)})`, tone: 'refused' };
  if (verdict.startsWith('failed:')) return { label: `Failed (${verdict.slice('failed:'.length)})`, tone: 'failed' };
  return { label: verdict, tone: 'failed' };
}

const TONE_CLASS: Record<ReturnType<typeof describeVerdict>['tone'], string> = {
  running: 'text-emerald-600 dark:text-emerald-400',
  ok: 'text-muted-foreground',
  refused: 'text-amber-600 dark:text-amber-400',
  pending: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
};

function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ActivityRow({ row, compact }: { row: DriveEnvActivityDTO; compact: boolean }) {
  const { label, tone } = describeVerdict(row);
  return (
    <li data-testid={`env-activity-${row.id}`} data-verdict={row.verdict} className={cn('flex min-w-0 items-start gap-2', compact ? 'text-[11px]' : 'text-sm')}>
      {tone === 'running' ? (
        <Loader2 role="img" aria-label="Running" className="mt-0.5 size-3 shrink-0 animate-spin text-emerald-500" />
      ) : (
        <span className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono" title={row.summary}>
          {row.summary}
        </span>
        <span className={cn('block truncate', TONE_CLASS[tone])}>
          {label}
          {row.approvalScope !== null && ` · approved (${row.approvalScope})`}
          {!compact && ` · ${timeOf(row.ts)}`}
        </span>
      </span>
    </li>
  );
}

export function EnvActivityPanel({ driveId, envId, enabled, compact = false, tailSize, className, scope = 'drive' }: EnvActivityPanelProps) {
  const { activity, running, isLoading, error } = useEnvActivity({ driveId, envId, scope }, { enabled });
  const tail = useMemo(() => activity.filter((row) => !(row.verdict === 'signed' && row.resultAt === null)).slice(0, tailSize ?? (compact ? 3 : 20)), [activity, compact, tailSize]);

  if (!enabled) return null;

  return (
    <section aria-label="Machine activity" data-testid={`env-activity-panel-${envId}`} className={cn('space-y-2', compact ? 'pl-6 pr-1 py-1' : '', className)}>
      <div>
        <h4 className={cn('font-medium text-muted-foreground', compact ? 'text-[10px] uppercase tracking-wide' : 'text-xs uppercase tracking-wide')}>
          Running now{running.length > 0 && ` (${running.length})`}
        </h4>
        {running.length === 0 ? (
          <p className={cn('text-muted-foreground', compact ? 'text-[11px]' : 'text-sm')}>{isLoading ? 'Loading…' : 'Nothing is running on this machine.'}</p>
        ) : (
          <ul className="space-y-1">
            {running.map((row) => (
              <ActivityRow key={row.id} row={row} compact={compact} />
            ))}
          </ul>
        )}
      </div>
      {(tail.length > 0 || !compact) && (
        <div>
          <h4 className={cn('font-medium text-muted-foreground', compact ? 'text-[10px] uppercase tracking-wide' : 'text-xs uppercase tracking-wide')}>Recent</h4>
          {tail.length === 0 ? (
            <p className={cn('text-muted-foreground', compact ? 'text-[11px]' : 'text-sm')}>{error ? 'Could not load activity.' : 'Nothing has run yet.'}</p>
          ) : (
            <ul className="space-y-1">
              {tail.map((row) => (
                <ActivityRow key={row.id} row={row} compact={compact} />
              ))}
            </ul>
          )}
        </div>
      )}
      {error && compact ? <p className="text-[11px] text-red-600 dark:text-red-400">Could not load activity.</p> : null}
    </section>
  );
}
