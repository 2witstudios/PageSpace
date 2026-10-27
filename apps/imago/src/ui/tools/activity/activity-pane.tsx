'use client';

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import type { ApiClient } from '@/api/client';
import { cn } from '../../cn';
import { renderToolPane, renderToolScreenRow, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { toolScreenHref, useToolScreen } from '../../frame/tool-pane/tool-screen';
import {
  activityRanges,
  activityQuery,
  parseActivityUrl,
  withActivityFilter,
  type ActivityFilterKey,
  type ActivityRange,
} from './activity-query';

/** The resources the API can filter on (C-Drive-Activity's Resource chips). */
const resources = ['page', 'drive', 'permission', 'agent', 'member', 'role', 'file', 'message', 'conversation'];

const operations = ['create', 'update', 'delete', 'move', 'restore', 'rollback'];

const rangeText: Readonly<Record<ActivityRange, string>> = { '24h': '24h', '7d': '7 days', '30d': '30 days' };

type Actor = { readonly id: string; readonly name: string | null; readonly email: string };

const fetchActors = async (client: ApiClient, driveId: string): Promise<readonly Actor[]> => {
  const body = await client.apiFetch<{ actors?: readonly Actor[] }>(
    `/api/activities/actors?context=drive&driveId=${encodeURIComponent(driveId)}`,
  );
  return body.actors ?? [];
};

const filenameFrom = (response: Response): string => {
  const match = response.headers.get('Content-Disposition')?.match(/filename="(.+)"/);
  return match?.[1] ?? 'activity-export.csv';
};

const selectClass = 'h-8 w-full rounded-lg border border-hairline bg-background px-2 text-sm text-ink';
const labelClass = 'text-2xs font-medium text-ink-faint';

/**
 * The Activity tool's pane (C-Drive-Activity): the filters, written to the URL so the middle
 * timeline reads the same state. On Home (`allDrives`) the timeline is the viewer's own activity
 * across every drive, so there is no one else to filter by.
 */
export function ActivityPane({ driveId, close, variant, scope: scopeSwitch = null, allDrives = false }: ToolPaneProps & { readonly allDrives?: boolean }): ReactNode {
  const queryDriveId = allDrives ? null : driveId;
  const client = useApiClient();
  const screen = useToolScreen(driveId, 'activity');
  const searchParams = useSearchParams();
  const current = new URLSearchParams(searchParams.toString());
  const state = parseActivityUrl(current);
  const { data: actors = [] } = useSWR(allDrives ? null : (['imago:activity-actors', driveId] as const), ([, id]) =>
    fetchActors(client, id),
  );
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const setFilter = (key: ActivityFilterKey, value: string | undefined) => {
    // A filter set from the pane alone opens the timeline beside it, filtered.
    const query = withActivityFilter(current, key, value).toString();
    screen.open(query ? `?${query}` : '');
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportFailed(false);
    try {
      const response = await client.apiStream(`/api/activities/export?${activityQuery(state, queryDriveId, new Date()).toString()}`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filenameFrom(response);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  return renderToolPane({
    title: 'Activity',
    label: 'Filters',
    close,
    scope: scopeSwitch,
    variant,
    children: (
      <div className="flex flex-col gap-4 px-1 py-2">
        {renderToolScreenRow({ href: toolScreenHref(driveId, 'activity'), label: 'All activity', selected: screen.onScreen && searchParams.toString() === '' })}
        {allDrives ? null : <div className="flex flex-col gap-1">
          <label htmlFor="activity-actor" className={labelClass}>People &amp; agents</label>
          <select
            id="activity-actor"
            className={selectClass}
            value={state.actorId ?? ''}
            onChange={(event) => setFilter('actorId', event.target.value || undefined)}
          >
            <option value="">Everyone</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>{actor.name || actor.email}</option>
            ))}
          </select>
        </div>}

        <div className="flex flex-col gap-1">
          <label htmlFor="activity-operation" className={labelClass}>Operation</label>
          <select
            id="activity-operation"
            className={selectClass}
            value={state.operation ?? ''}
            onChange={(event) => setFilter('operation', event.target.value || undefined)}
          >
            <option value="">All operations</option>
            {operations.map((operation) => (
              <option key={operation} value={operation}>{operation}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <span className={labelClass}>Resource</span>
          <div className="flex flex-wrap gap-1">
            {resources.map((resource) => {
              const pressed = state.resourceType === resource;
              return (
                <button
                  key={resource}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setFilter('resourceType', pressed ? undefined : resource)}
                  className={cn(
                    'h-8 rounded-full border border-hairline px-2 text-2xs',
                    pressed ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink',
                  )}
                >
                  {resource}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className={labelClass}>Date range</span>
          <div role="group" aria-label="Date range" className="flex gap-px rounded-lg bg-fill">
            {activityRanges.map((range) => {
              const pressed = state.range === range;
              return (
                <button
                  key={range}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setFilter('range', range === '7d' ? undefined : range)}
                  className={cn(
                    'h-8 flex-1 rounded-md text-sm',
                    pressed ? 'bg-background font-medium text-ink' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {rangeText[range]}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={exportCsv}
          disabled={exporting}
          className="h-8 w-full rounded-lg border border-hairline text-sm text-ink hover:bg-surface-overlay disabled:opacity-50"
        >
          Export CSV
        </button>
        {exportFailed ? <p role="alert" className="text-2xs text-status-danger">Export failed</p> : null}
      </div>
    ),
  });
}
