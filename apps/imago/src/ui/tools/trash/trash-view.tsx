'use client';

// The trash middle (C-Drive-Trash): the drive's trashed pages as a tree, with
// Restore on each top-level row and an inline confirm before Delete forever.
// The Trash pane beside it is the shell's; the Type filter lives in the URL
// (?type=pages|files), so a reload keeps it, and the pane and the view's own
// Type control both write it.

import { useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { DRIVES, drivesFrom } from '../../frame/drives/drives';
import { renderEmptyState, renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { renderButton } from '../../components/button/button.render';
import { renderIcon } from '../../components/icon/icon.render';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { ApiError } from '@/api/errors';
import { useTrash } from './use-trash';
import {
  deleteDetail,
  metaLabel,
  rowsMatching,
  trashRows,
  trashedLabel,
  wasInLabel,
  type TrashFilter,
  type TrashRow,
} from './trash-model';

const TYPE_OPTIONS: readonly { readonly value: TrashFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pages', label: 'Pages' },
  { value: 'files', label: 'Files' },
];

/** Where the Type filter sends the view: the drive's trash screen, with ?type= unless All. */
export const trashFilterHref = (driveId: string, filter: TrashFilter): string => {
  const path = `/${encodeURIComponent(driveId)}/trash/view`;
  return filter === 'all' ? path : `${path}?type=${filter}`;
};

/** Fixed column widths for the treegrid's right-hand columns, so the rows line up under the head. */

const headRowClass = 'flex items-center gap-4 border-b border-hairline px-3 py-2 text-xs text-ink-faint';
const rowClass = 'flex min-h-11 items-center gap-4 border-b border-hairline px-3 hover:bg-tint';
const typeButtonClass = 'h-7 rounded-md px-3 text-sm text-ink-muted hover:text-ink';
const typeButtonOnClass = 'h-7 rounded-md bg-tint px-3 text-sm font-medium text-ink';

export type TrashViewProps = {
  readonly driveId: string;
  readonly filter: TrashFilter;
  /** Moves the view to another filter (the page navigates, so the URL carries it). */
  readonly onFilterChange: (href: string) => void;
};

export function TrashView({ driveId, filter, onFilterChange }: TrashViewProps): ReactNode {
  const { tree, error, titles, retry, restore, remove } = useTrash(driveId);
  const { data: drives } = useSWR(DRIVES);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);

  if (error !== undefined && error !== null) {
    if (error instanceof ApiError && error.status === 403) {
      return renderEmptyState({
        title: 'Only drive owners and admins can see the trash',
        detail: 'Ask an owner or admin of this drive to restore or delete what is in it.',
      });
    }
    return renderErrorState({ title: 'Could not load the trash', retry });
  }
  if (tree === undefined) return renderLoadingState('Loading trash…');

  const driveName = driveNameOf(drives, driveId);
  const rows = trashRows(tree);
  const visible = rowsMatching(rows, filter);
  const confirming: TrashRow | undefined = rows.find((row) => row.id === confirmingId && row.top);
  const now = new Date();

  /** Runs a restore or a permanent delete once: the row is taken out when the server agrees. */
  const act = async (pageId: string, write: (id: string) => Promise<void>): Promise<void> => {
    if (pendingId !== null) return;
    setPendingId(pageId);
    setActionFailed(false);
    try {
      await write(pageId);
      setConfirmingId(null);
    } catch {
      setActionFailed(true);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section aria-label="Trash" className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-md font-semibold text-ink">Trash</h1>
          <p className="m-0 text-sm text-ink-muted">
            Pages trashed from {driveName ?? 'this drive'}, with whatever was inside them. Restoring a folder brings
            its pages back with it.
          </p>
        </div>
        <div role="group" aria-label="Type" className="inline-flex gap-1 rounded-md bg-fill p-1">
          {TYPE_OPTIONS.map((option) => {
            const count = option.value === 'all' ? ` · ${rows.length}` : '';
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                className={filter === option.value ? typeButtonOnClass : typeButtonClass}
                onClick={() => onFilterChange(trashFilterHref(driveId, option.value))}
              >
                {option.label}
                {count}
              </button>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        renderEmptyState({
          title: 'Nothing in the trash',
          detail: 'Pages you trash show up here until they are restored or deleted.',
        })
      ) : (
        <div role="treegrid" aria-label="Trashed pages" className="flex flex-col border-t border-hairline">
          <div role="row" className={headRowClass}>
            <span role="columnheader" className="min-w-0 flex-1">Name</span>
            <span role="columnheader" className="w-trash-was-in flex-none">Was in</span>
            <span role="columnheader" className="w-trash-when flex-none">Trashed</span>
            <span role="columnheader" className="w-trash-actions flex-none" />
          </div>
          {visible.length === 0 ? (
            <p className="m-0 px-3 py-4 text-sm text-ink-muted">Nothing here matches this filter.</p>
          ) : (
            visible.map((row) => {
              const icon = pageTypeIcons[row.type];
              const meta = metaLabel(row);
              const wasIn = wasInLabel(row, titles);
              const busy = pendingId !== null;
              return (
                <div key={row.id} role="row" aria-level={row.depth + 1} className={rowClass}>
                  <span
                    role="gridcell"
                    className="flex min-w-0 flex-1 items-center gap-2 text-ink"
                    style={{ paddingLeft: `${row.depth * 16}px` }}
                  >
                    <span className={icon.hue} aria-hidden="true">
                      {renderIcon({ name: icon.icon, size: 16 })}
                    </span>
                    <span className="truncate">{row.title}</span>
                    {meta === null ? null : <span className="shrink-0 text-xs text-ink-faint">{meta}</span>}
                  </span>
                  <span role="gridcell" className="w-trash-was-in flex-none truncate text-ink-muted">{wasIn ?? '—'}</span>
                  <span role="gridcell" className="w-trash-when flex-none text-ink-muted">{trashedLabel(row.trashedAt, now)}</span>
                  <span role="gridcell" className="flex w-trash-actions flex-none justify-end gap-1">
                    {row.top ? (
                      <>
                        {renderButton({
                          variant: 'ghost',
                          disabled: busy,
                          onClick: () => void act(row.id, restore),
                          children: (
                            <>
                              {renderIcon({ name: 'undo', size: 12 })}
                              Restore
                            </>
                          ),
                        })}
                        {renderButton({
                          variant: 'ghost',
                          className: 'text-status-danger',
                          disabled: busy,
                          'aria-label': `Delete ${row.title} forever`,
                          onClick: () => {
                            setActionFailed(false);
                            setConfirmingId(row.id);
                          },
                          children: 'Delete forever',
                        })}
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {confirming === undefined ? null : (
        <div
          role="alertdialog"
          aria-label={`Delete ${confirming.title} forever`}
          aria-describedby="trash-delete-detail"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-status-danger p-4"
        >
          {renderIcon({ name: 'trash', size: 18 })}
          <p id="trash-delete-detail" className="m-0 min-w-0 flex-1 text-sm text-ink">
            <strong>Delete “{confirming.title}” forever?</strong> {deleteDetail(confirming)}
          </p>
          {renderButton({
            variant: 'secondary',
            disabled: pendingId !== null,
            onClick: () => setConfirmingId(null),
            children: 'Cancel',
          })}
          {renderButton({
            variant: 'secondary',
            className: 'text-status-danger',
            disabled: pendingId !== null,
            onClick: () => void act(confirming.id, remove),
            children: 'Delete forever',
          })}
        </div>
      )}
      {actionFailed ? (
        <p role="alert" className="m-0 text-sm text-status-danger">
          That did not go through. Check your connection, then try again.
        </p>
      ) : null}
    </section>
  );
}

const driveNameOf = (body: unknown, driveId: string): string | null =>
  drivesFrom(body, null)?.find((drive) => drive.id === driveId)?.name ?? null;
