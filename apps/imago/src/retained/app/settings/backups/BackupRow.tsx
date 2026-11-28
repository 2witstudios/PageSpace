'use client';

import type { ReactNode } from 'react';
import { Download, Eye, RotateCcw, Loader2 } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { Badge } from '@/retained/components/ui/badge';
import { Button } from '@/retained/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/retained/components/ui/tooltip';
import { sourceLabel, statusVariant, type SerializedBackup } from './utils';

type RowActionProps = {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
};

/** An icon action; disabled actions keep their tooltip through a span wrapper. */
function RowAction({ label, disabled, onClick, children }: RowActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export type BackupRowProps = {
  readonly backup: SerializedBackup;
  readonly downloading: boolean;
  readonly anyDownloading: boolean;
  readonly onView: (backup: SerializedBackup) => void;
  readonly onDownload: (backup: SerializedBackup) => void;
  readonly onRestore: (backup: SerializedBackup) => void;
  /** The inline restore preview, shown under the row being restored. */
  readonly children?: ReactNode;
};

/**
 * One backup in "All backups": drive chip, label, drive and when, source pill, status pill and the
 * three actions. View, Download and Restore need a ready backup; pending and failed rows keep them disabled.
 */
export function BackupRow({ backup, downloading, anyDownloading, onView, onDownload, onRestore, children }: BackupRowProps) {
  const ready = backup.status === 'ready';
  const drive = backup.driveName ?? 'Unknown drive';
  const when = formatDistanceToNow(new Date(backup.createdAt), { addSuffix: true });
  const label = backup.label ?? `Backup ${backup.id.slice(0, 8)}`;

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground"
        >
          {drive.slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground" title={format(new Date(backup.createdAt), 'PPpp')}>
            {drive} · {when}
          </span>
        </div>
        <Badge variant="outline">{sourceLabel(backup.source)}</Badge>
        <Badge variant={statusVariant(backup.status)}>{backup.status}</Badge>
        <div className="flex flex-none items-center gap-0.5">
          <RowAction label="View snapshot" disabled={!ready} onClick={() => onView(backup)}>
            <Eye className="h-4 w-4" />
          </RowAction>
          <RowAction
            label="Download"
            disabled={!ready || anyDownloading}
            onClick={() => onDownload(backup)}
          >
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </RowAction>
          <RowAction label="Restore drive to this backup" disabled={!ready} onClick={() => onRestore(backup)}>
            <RotateCcw className="h-4 w-4" />
          </RowAction>
        </div>
      </div>
      {children}
    </div>
  );
}
