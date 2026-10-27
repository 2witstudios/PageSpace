'use client';

import useSWR from 'swr';
import { Loader2 } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import type { RestoreDiff } from '@/retained-adapters/ui-contracts';
import { buildDiffSummary } from '@/retained/components/BackupDiffPreview';
import type { SerializedBackup } from './utils';

const fetchDiff = async (url: string): Promise<RestoreDiff> => {
  const r = await fetchWithAuth(url);
  if (!r.ok) throw new Error('Failed to load restore preview');
  const { diff } = (await r.json()) as { diff: RestoreDiff };
  return diff;
};

export type BackupRestorePreviewProps = {
  readonly driveId: string;
  readonly backup: SerializedBackup;
  readonly restoring: boolean;
  readonly onRestore: (backupId: string) => void;
  readonly onCancel: () => void;
};

/**
 * The inline "Restore preview" for the backup being restored: the page counts from the diff route,
 * then Restore now (the restore route, through `onRestore`) and Cancel.
 */
export function BackupRestorePreview({ driveId, backup, restoring, onRestore, onCancel }: BackupRestorePreviewProps) {
  const { data: diff, error, isLoading } = useSWR<RestoreDiff>(
    `/api/drives/${driveId}/backups/${backup.id}/diff`,
    fetchDiff,
    { revalidateOnFocus: false },
  );

  return (
    <div
      role="region"
      aria-label="Restore preview"
      className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-4 text-sm"
    >
      {error ? (
        <p className="text-muted-foreground">Failed to load the restore preview.</p>
      ) : isLoading || diff === undefined ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading restore preview…</span>
        </div>
      ) : (
        <PreviewCounts diff={diff} />
      )}
      <p className="text-xs text-muted-foreground">A safety snapshot of the current state is taken first, so you can undo this.</p>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" disabled={restoring || diff === undefined} onClick={() => onRestore(backup.id)}>
          {restoring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Restore now
        </Button>
        <Button variant="outline" size="sm" disabled={restoring} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The three counts the board shows: restored, soft-deleted and unchanged. */
export function PreviewCounts({ diff }: { readonly diff: RestoreDiff }) {
  const summary = buildDiffSummary(diff);
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      <li>
        <span className="font-mono">{summary.total}</span> pages will be restored from the snapshot
      </li>
      <li className={summary.orphanCount > 0 ? 'text-amber-600' : 'text-muted-foreground'}>
        <span className="font-mono">{summary.orphanCount}</span> pages added since the backup will be soft-deleted
      </li>
      <li className="text-muted-foreground">
        <span className="font-mono">{summary.unchangedCount}</span> pages unchanged
      </li>
    </ul>
  );
}
