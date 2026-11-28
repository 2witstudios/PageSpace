'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { History, Loader2, Search, Sparkles } from 'lucide-react';
import { Badge } from '@/retained/components/ui/badge';
import { Button } from '@/retained/components/ui/button';
import { Label } from '@/retained/components/ui/label';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Switch } from '@/retained/components/ui/switch';
import { fetchJSON, post } from '@/retained/lib/auth/auth-fetch';
import { useActivitySocket } from '@/retained/hooks/useActivitySocket';
import { cn } from '@/retained/lib/utils';
import type { RollbackToPointPreview } from '@/retained-adapters/ui-contracts';
import type { ActivityActionPreview, ActivityActionResult } from '@/retained/types/activity-actions';
import {
  actorOf,
  aiViaOf,
  canUndoNow,
  filterVersions,
  groupVersions,
  initialOf,
  retentionLabelOf,
  rollbackToPointCount,
  rolledBackIds,
  summaryOf,
  timeLabelOf,
  verbOf,
  type HistoryFilter,
  type HistoryVersion,
} from './page-history-model';

interface HistoryResponse {
  versions: HistoryVersion[];
  retentionDays: number;
}

const PAGE_SIZE = 50;

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Undo / rollback for one expanded row. Its previews load when it mounts and reset when it closes. */
function HistoryRowDetail({
  activityId,
  rolledBack,
  onApplied,
}: {
  readonly activityId: string;
  readonly rolledBack: boolean;
  readonly onApplied: () => void;
}) {
  const forceId = useId();
  const [undoPreview, setUndoPreview] = useState<ActivityActionPreview | null>(null);
  const [pointPreview, setPointPreview] = useState<RollbackToPointPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      post<{ preview: ActivityActionPreview | null }>(`/api/activities/${activityId}/rollback`, {
        context: 'page',
        dryRun: true,
      }),
      fetchJSON<RollbackToPointPreview>(`/api/activities/${activityId}/rollback-to-point?context=page`),
    ])
      .then(([undo, point]) => {
        if (cancelled) return;
        setUndoPreview(undo.preview ?? null);
        setPointPreview(point);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessageOf(err, 'Failed to load the changes to apply'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  const pointCount = pointPreview ? rollbackToPointCount(pointPreview.activitiesAffected, force) : 0;
  const undoable = canUndoNow(undoPreview, force);

  const runAction = async (action: () => Promise<ActivityActionResult>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onApplied();
    } catch (err) {
      setError(errorMessageOf(err, 'Action failed'));
    } finally {
      setBusy(false);
    }
  };

  const undoChange = () =>
    runAction(() => post<ActivityActionResult>(`/api/activities/${activityId}/rollback`, { context: 'page', force }));

  const rollbackToPoint = () =>
    runAction(() => post<ActivityActionResult>(`/api/activities/${activityId}/rollback-to-point`, { context: 'page', force }));

  return (
    <div className="mb-2 ml-[46px] mr-2 flex flex-col gap-2.5">
      {rolledBack ? <p className="text-xs text-muted-foreground">This change has already been rolled back.</p> : null}
      <div className="overflow-hidden rounded-md border text-xs">
        <div className="border-b bg-muted/50 px-2.5 py-1.5 font-semibold text-muted-foreground">Changes to apply</div>
        <div className="flex flex-col gap-2 p-2.5">
          {loading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading changes
            </span>
          ) : null}
          {!loading && undoPreview?.isNoOp ? <span className="text-muted-foreground">No changes needed.</span> : null}
          {undoPreview && !undoPreview.canExecute && undoPreview.reason ? (
            <p className="text-destructive">Cannot undo: {undoPreview.reason}</p>
          ) : null}
          {undoPreview?.warnings.map((warning) => (
            <p key={warning} className="text-amber-700 dark:text-amber-400">{warning}</p>
          ))}
          {undoPreview?.changes.map((change) => (
            <div key={change.id} className="rounded bg-muted/50 p-2">
              <div className="font-medium">{change.label}</div>
              {change.description ? <div className="text-muted-foreground">{change.description}</div> : null}
              {change.fields && change.fields.length > 0 ? (
                <div className="mt-1 text-muted-foreground">Fields: {change.fields.join(', ')}</div>
              ) : null}
            </div>
          ))}
          {undoPreview?.hasConflict && undoPreview.conflictFields.length > 0 ? (
            <p className="text-amber-700 dark:text-amber-400">
              Changed since this activity. Conflicting fields: {undoPreview.conflictFields.join(', ')}
            </p>
          ) : null}
          {undoPreview?.requiresForce ? (
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={forceId} className="text-xs">Force undo (overwrite newer changes)</Label>
              <Switch id={forceId} checked={force} onCheckedChange={setForce} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || rolledBack || !undoable}
          onClick={undoChange}
        >
          <History aria-hidden="true" />
          Undo this change
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || rolledBack || pointCount === 0}
          onClick={rollbackToPoint}
        >
          Rollback to this point
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The page history body: search, All / AI filter, the retention meta, and grouped rows that
 * expand into the changes to apply. Mounted inside the page-history sheet.
 */
export default function SidebarActivityTab({ pageId }: { readonly pageId: string }) {
  const searchId = useId();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [query, setQuery] = useState('');
  const [versions, setVersions] = useState<HistoryVersion[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    // includeAiOnly is parsed as a boolean on the server, so it is only sent when it is true.
    if (filter === 'ai') params.set('includeAiOnly', 'true');
    try {
      const data = await fetchJSON<HistoryResponse>(
        `/api/pages/${encodeURIComponent(pageId)}/history?${params.toString()}`,
      );
      setVersions(data.versions);
      setRetentionDays(data.retentionDays);
    } catch (err) {
      setError(errorMessageOf(err, 'Failed to load page history'));
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [pageId, filter]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useActivitySocket({
    context: 'page',
    contextId: pageId,
    onActivityLogged: loadHistory,
    driveId: null,
    pageId,
  });

  const rolledBack = useMemo(() => rolledBackIds(versions), [versions]);
  const visible = useMemo(() => filterVersions(versions, query), [versions, query]);
  // Grouping depends on the day, so it is recomputed on each render rather than memoized.
  const now = new Date();
  const groups = groupVersions(visible, now);

  const pillClass = (on: boolean) =>
    cn(
      'h-7 rounded-md px-2.5 text-xs transition-colors',
      on ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2.5 border-b p-3">
        <div className="flex h-8 items-center gap-2 rounded-md bg-muted/50 px-2.5 text-muted-foreground">
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <Label htmlFor={searchId} className="sr-only">Search activity</Label>
          <input
            id={searchId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search activity..."
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center gap-2.5">
          <div role="group" aria-label="Show" className="flex rounded-md bg-muted/50 p-0.5">
            <button
              type="button"
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
              className={pillClass(filter === 'all')}
            >
              All changes
            </button>
            <button
              type="button"
              aria-pressed={filter === 'ai'}
              onClick={() => setFilter('ai')}
              className={pillClass(filter === 'ai')}
            >
              AI changes
            </button>
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            {retentionDays === null ? null : retentionLabelOf(retentionDays)}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pt-1.5 pb-4">
        {loading && versions.length === 0 ? (
          <div className="flex flex-col gap-3 p-2" aria-label="Loading page history">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : null}
        {error ? <p role="alert" className="p-2 text-sm text-destructive">{error}</p> : null}
        {!loading && !error && visible.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">
            {filter === 'ai' ? 'No AI changes to show.' : 'No changes to show.'}
          </p>
        ) : null}

        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-2 pt-3 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              {group.label}
            </div>
            {group.items.map((version) => {
              const open = openId === version.id;
              const isRolledBack = rolledBack.has(version.id);
              return (
                <div key={version.id} className={cn('rounded-lg', open && 'bg-accent/40')}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : version.id)}
                    className="flex w-full items-start gap-2.5 p-2 text-left"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-7 w-7 flex-none items-center justify-center text-[10.5px] font-semibold',
                        version.isAiGenerated ? 'rounded-lg bg-primary text-primary-foreground' : 'rounded-full bg-muted',
                      )}
                      aria-hidden="true"
                    >
                      {version.isAiGenerated ? <Sparkles className="h-3 w-3" /> : initialOf(version)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm leading-snug">
                        <strong className="font-semibold">{actorOf(version)}</strong>{' '}
                        <span className="text-muted-foreground">{verbOf(version)}</span>
                      </span>
                      <span className="text-xs leading-snug">{summaryOf(version)}</span>
                      <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <time dateTime={version.timestamp}>{timeLabelOf(version, now)}</time>
                        {version.isAiGenerated ? (
                          <Badge variant="outline" className="h-[18px] px-1.5 text-[11px]">
                            AI · {aiViaOf(version)}
                          </Badge>
                        ) : null}
                        {isRolledBack ? (
                          <Badge variant="secondary" className="h-[18px] px-1.5 text-[11px]">Rolled back</Badge>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  {open ? (
                    <HistoryRowDetail
                      key={version.id}
                      activityId={version.id}
                      rolledBack={isRolledBack}
                      onApplied={() => {
                        setOpenId(null);
                        void loadHistory();
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
