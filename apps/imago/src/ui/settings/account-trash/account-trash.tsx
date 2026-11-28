'use client';

// The trashed drives screen (C-Account-Trash): the drives the viewer owns that are in the trash, each with
// Restore and a type-to-confirm Delete permanently. Drive data comes from apps/web through the drive store.
// The page count and the purge countdown have no API on this branch, so they are left out.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useDriveStore, type Drive } from '@/retained/hooks/useDrive';
import { post, del } from '@/retained/lib/auth/auth-fetch';
import { Icon } from '../../components/icon/icon';
import { SettingsGroup, SettingsScreen } from '../settings-screen/settings-screen';
import { confirmMatches, trashedDrivesOf, trashedLabel } from './account-trash-model';

export type AccountTrashViewProps = {
  readonly drives: readonly Drive[];
  readonly confirmingId: string | null;
  readonly typed: string;
  readonly onRestore: (drive: Drive) => void;
  readonly onAskDelete: (drive: Drive) => void;
  readonly onTyped: (value: string) => void;
  readonly onCancelDelete: () => void;
  readonly onDelete: (drive: Drive) => void;
};

/** The trash page's markup, given its drives and handlers: no requests, so it renders the same in every test. */
export function AccountTrashView({
  drives,
  confirmingId,
  typed,
  onRestore,
  onAskDelete,
  onTyped,
  onCancelDelete,
  onDelete,
}: AccountTrashViewProps) {
  return (
    <SettingsScreen
      title="Trashed drives"
      lede="Drives you moved to trash. Restore one to bring it back, or delete it for good. Trashed pages live in each drive’s own Trash."
    >
      {drives.length === 0 ? (
        <p className="text-sm text-ink-muted">No trashed drives.</p>
      ) : (
        <SettingsGroup label="Trashed drives">
          {drives.map((drive) => (
            <div key={drive.id} className="flex flex-col">
              <div className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{drive.name}</div>
                  <div className="mt-px text-xs text-ink-muted">{trashedLabel(drive)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(drive)}
                  className="inline-flex h-8 items-center rounded-lg border border-hairline px-3 text-sm text-ink hover:bg-tint"
                >
                  Restore
                </button>
                <button
                  type="button"
                  aria-label="Delete permanently"
                  title="Delete permanently"
                  onClick={() => onAskDelete(drive)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-status-danger hover:bg-tint"
                >
                  <Icon name="trash" />
                </button>
              </div>
              {confirmingId === drive.id ? (
                <form
                  aria-label="Confirm permanent delete"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (confirmMatches(typed, drive.name)) onDelete(drive);
                  }}
                  className="flex flex-col gap-3 border-t border-hairline bg-tint px-4 py-3"
                >
                  <div className="text-sm font-medium text-ink">Delete “{drive.name}” forever?</div>
                  <p className="text-sm text-ink-muted">All of its pages, files and messages are removed. This can’t be undone.</p>
                  <label className="flex flex-col gap-1 text-sm text-ink">
                    Type the drive name to confirm
                    <input
                      value={typed}
                      onChange={(event) => onTyped(event.target.value)}
                      placeholder="Enter drive name"
                      className="h-8 rounded-lg border border-hairline bg-fill px-3 text-sm text-ink"
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={!confirmMatches(typed, drive.name)}
                      className="inline-flex h-8 items-center rounded-lg bg-status-danger px-3 text-sm text-fill disabled:opacity-50"
                    >
                      Delete permanently
                    </button>
                    <button type="button" onClick={onCancelDelete} className="inline-flex h-8 items-center rounded-lg border border-hairline px-3 text-sm text-ink hover:bg-tint">
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ))}
        </SettingsGroup>
      )}
    </SettingsScreen>
  );
}

/** The trash screen with its store: restore and permanent delete, each reloading the list when it is done. */
export function AccountTrash({ viewerId }: { readonly viewerId: string }) {
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const removeDrive = useDriveStore((state) => state.removeDrive);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    void fetchDrives(true, true);
  }, [fetchDrives]);

  const trashed = useMemo(() => trashedDrivesOf(drives, viewerId), [drives, viewerId]);

  const restore = async (drive: Drive) => {
    const toastId = toast.loading('Restoring drive...');
    try {
      await post(`/api/drives/${drive.id}/restore`);
      await fetchDrives(true, true);
      toast.success('Drive restored.', { id: toastId });
    } catch {
      toast.error('Error restoring drive.', { id: toastId });
    }
  };

  const remove = async (drive: Drive) => {
    const toastId = toast.loading('Permanently deleting drive...');
    try {
      await del(`/api/trash/drives/${drive.id}`);
      removeDrive(drive.id);
      toast.success('Drive permanently deleted.', { id: toastId });
    } catch {
      toast.error('Error permanently deleting drive.', { id: toastId });
    } finally {
      setConfirmingId(null);
      setTyped('');
    }
  };

  return (
    <AccountTrashView
      drives={trashed}
      confirmingId={confirmingId}
      typed={typed}
      onRestore={(drive) => void restore(drive)}
      onAskDelete={(drive) => {
        setConfirmingId(drive.id);
        setTyped('');
      }}
      onTyped={setTyped}
      onCancelDelete={() => {
        setConfirmingId(null);
        setTyped('');
      }}
      onDelete={(drive) => void remove(drive)}
    />
  );
}
