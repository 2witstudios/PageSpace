'use client';

import useSWR, { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { DeletePageDialog } from '@/retained/components/dialogs/DeletePageDialog';
import { RenameDialog } from '@/retained/components/dialogs/RenameDialog';
import { MovePageDialog } from '@/retained/components/dialogs/MovePageDialog';
import { CopyPageDialog } from '@/retained/components/dialogs/CopyPageDialog';
import { ShareDialog } from '@/retained/components/layout/middle-content/content-header/page-settings/ShareDialog';
import { del, patch } from '@/retained/lib/auth/auth-fetch';
import { useUIStore } from '@/retained/stores/useUIStore';
import { pageKey, usePage } from '../page-object/page-object';
import { menuPageOf } from '../page-actions/page-actions';
import type { PageActionDialog } from '../page-actions/page-actions-model';
import { driveTreeKey, hasChildrenIn, selectedPageOf } from './page-head-dialogs-model';

export type PageHeadDialogsProps = {
  readonly pageId: string;
  readonly driveId: string;
  /** The dialog the "…" menu asked for; null when none is open. */
  readonly dialog: PageActionDialog | null;
  /** Void action: closes the open dialog. */
  readonly onClose: () => void;
};

/**
 * The dialogs the page head's "…" menu opens (Rename, Move to…, Copy to…, Trash, Permissions),
 * the retained dialogs with the same calls the Files tree's rows make. Add child page opens the
 * create palette instead.
 */
export function PageHeadDialogs({ pageId, driveId, dialog, onClose }: PageHeadDialogsProps) {
  const { mutate } = useSWRConfig();
  const page = menuPageOf(usePage(pageId).data);
  const tree = useSWR<unknown>(driveTreeKey(driveId)).data;
  if (page === null) return null;

  const refresh = async () => {
    await mutate(driveTreeKey(driveId));
    await mutate(pageKey(pageId));
  };

  const rename = async (title: string) => {
    const toastId = toast.loading('Renaming page...');
    try {
      await patch(`/api/pages/${pageId}`, { title });
      await refresh();
      toast.success('Page renamed.', { id: toastId });
    } catch {
      toast.error('Error renaming page.', { id: toastId });
    } finally {
      onClose();
    }
  };

  const trash = async (trashChildren: boolean) => {
    const toastId = toast.loading('Moving page to trash...');
    try {
      await del(`/api/pages/${pageId}`, { trash_children: trashChildren });
      await refresh();
      toast.success('Page moved to trash.', { id: toastId });
    } catch {
      toast.error('Error moving page to trash.', { id: toastId });
    } finally {
      onClose();
    }
  };

  const selected = [selectedPageOf(pageId, driveId, page)];
  return (
    <RetainedSurface fill={false}>
      <RenameDialog
        isOpen={dialog === 'rename'}
        onClose={onClose}
        onRename={(title) => void rename(title)}
        initialName={page.title}
        title="Rename Page"
        description="Enter a new name for your page."
      />
      <DeletePageDialog
        isOpen={dialog === 'trash'}
        onClose={onClose}
        onConfirm={(trashChildren) => void trash(trashChildren)}
        hasChildren={hasChildrenIn(tree, pageId)}
      />
      <MovePageDialog isOpen={dialog === 'move'} onClose={onClose} pages={selected} onSuccess={() => void refresh()} />
      <CopyPageDialog isOpen={dialog === 'copy'} onClose={onClose} pages={selected} onSuccess={() => void refresh()} />
      <ShareDialog
        pageId={pageId}
        defaultTab="permissions"
        open={dialog === 'permissions'}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      />
    </RetainedSurface>
  );
}

/** Void action: the menu's Add child page opens the create palette under this page. */
export const openAddChild = (pageId: string): void => useUIStore.getState().openQuickCreate(pageId, null);
