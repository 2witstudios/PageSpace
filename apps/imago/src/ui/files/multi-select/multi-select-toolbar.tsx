'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useApiClient } from '@/api/swr-provider';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/retained/components/ui/alert-dialog';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import { bulkTrash } from '../page-actions/page-actions-api';
import { selectedCountLabel, trashConfirmBody, trashedToast } from './multi-select-model';
import type { MultiSelection } from './use-multi-select';

export type MultiSelectToolbarProps = {
  readonly selection: MultiSelection;
  /** Void action: opens Move to… for these pages (the Move dialog's container owns it). */
  readonly onMove?: (pageIds: readonly string[]) => void;
  /** Void action: opens Copy to… for these pages. */
  readonly onCopy?: (pageIds: readonly string[]) => void;
  /** Void action: the tree reloads once pages are in the trash. */
  readonly onTrashed?: (pageIds: readonly string[]) => void;
};

const actionClass =
  'h-7 flex-none rounded-md px-2 text-sm text-ink-muted hover:bg-fill hover:text-ink disabled:opacity-50';

/**
 * The tree's multi-select toolbar: "<n> selected" with Move, Copy, Delete and Cancel. Delete
 * asks first ("Move to Trash?"), then sends the pages to the trash in one request. Nothing shows
 * while Select multiple is off.
 */
export function MultiSelectToolbar({ selection, onMove, onCopy, onTrashed }: MultiSelectToolbarProps) {
  const client = useApiClient();
  const [confirming, setConfirming] = useState(false);
  if (!selection.active) return null;
  const count = selection.pageIds.length;
  const empty = count === 0;

  const trash = async () => {
    const pageIds = selection.pageIds;
    const toastId = toast.loading('Moving pages to trash...');
    try {
      await bulkTrash(client, pageIds);
      toast.success(trashedToast(pageIds.length), { id: toastId });
      setConfirming(false);
      selection.exit();
      onTrashed?.(pageIds);
    } catch {
      toast.error('Error moving pages to trash.', { id: toastId });
      setConfirming(false);
    }
  };

  return (
    <div className="sticky top-0 z-10">
      <ToolbarStrip label="Multi-select">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{selectedCountLabel(count)}</span>
        <button type="button" className={actionClass} disabled={empty} onClick={() => onMove?.(selection.pageIds)}>
          Move
        </button>
        <button type="button" className={actionClass} disabled={empty} onClick={() => onCopy?.(selection.pageIds)}>
          Copy
        </button>
        <button type="button" className={actionClass} disabled={empty} onClick={() => setConfirming(true)}>
          Delete
        </button>
        <button type="button" className={actionClass} onClick={selection.exit} aria-label="Cancel selection">
          Cancel
        </button>
      </ToolbarStrip>
      <RetainedSurface fill={false}>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Move to Trash?</AlertDialogTitle>
              <AlertDialogDescription>{trashConfirmBody(count)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void trash()}>Move to Trash</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </RetainedSurface>
    </div>
  );
}
