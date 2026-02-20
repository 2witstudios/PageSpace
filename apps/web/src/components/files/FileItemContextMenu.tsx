'use client';

import { useState, useCallback, useMemo, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  Pencil,
  Star,
  FolderInput,
  Copy,
  Trash2,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useFavorites } from '@/hooks/useFavorites';
import { useTabsStore } from '@/stores/useTabsStore';
import { DeletePageDialog } from '@/components/dialogs/DeletePageDialog';
import { RenameDialog } from '@/components/dialogs/RenameDialog';
import { MovePageDialog } from '@/components/dialogs/MovePageDialog';
import { CopyPageDialog } from '@/components/dialogs/CopyPageDialog';
import { patch, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { TreePage } from '@/hooks/usePageTree';
import type { SelectedPageInfo } from '@/stores/useMultiSelectStore';

interface FileItemContextMenuProps {
  item: TreePage;
  driveId: string;
  onMutate: () => void;
  children: ReactNode;
}

export function FileItemContextMenu({ item, driveId, onMutate, children }: FileItemContextMenuProps) {
  const router = useRouter();
  const [isRenameOpen, setRenameOpen] = useState(false);
  const [isConfirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [isMoveOpen, setMoveOpen] = useState(false);
  const [isCopyOpen, setCopyOpen] = useState(false);
  const { addFavorite, removeFavorite, isFavorite } = useFavorites();
  const createTab = useTabsStore((state) => state.createTab);

  const hasChildren = item.children && item.children.length > 0;
  const linkHref = `/dashboard/${driveId}/${item.id}`;

  const pageInfo: SelectedPageInfo = useMemo(() => ({
    id: item.id,
    title: item.title,
    type: item.type,
    driveId,
    parentId: item.parentId ?? null,
  }), [item.id, item.title, item.type, item.parentId, driveId]);

  const handleOpen = useCallback(() => {
    router.push(linkHref);
  }, [router, linkHref]);

  const handleOpenInNewTab = useCallback(() => {
    createTab({ path: linkHref, activate: false });
  }, [createTab, linkHref]);

  const handleRename = useCallback(async (newName: string) => {
    const toastId = toast.loading('Renaming page...');
    try {
      await patch(`/api/pages/${item.id}`, { title: newName });
      onMutate();
      toast.success('Page renamed.', { id: toastId });
    } catch {
      toast.error('Error renaming page.', { id: toastId });
    } finally {
      setRenameOpen(false);
    }
  }, [item.id, onMutate]);

  const handleFavoriteToggle = useCallback(async () => {
    const isCurrentlyFavorite = isFavorite(item.id);
    const action = isCurrentlyFavorite ? removeFavorite : addFavorite;
    const actionVerb = isCurrentlyFavorite ? 'Removing from' : 'Adding to';
    const toastId = toast.loading(`${actionVerb} favorites...`);
    try {
      await action(item.id);
      toast.success(`Page ${actionVerb.toLowerCase()} favorites.`, { id: toastId });
    } catch {
      toast.error('Error updating favorites.', { id: toastId });
    }
  }, [item.id, isFavorite, addFavorite, removeFavorite]);

  const handleDelete = useCallback(async (trashChildren: boolean) => {
    const toastId = toast.loading('Moving page to trash...');
    try {
      await del(`/api/pages/${item.id}`, { trash_children: trashChildren });
      onMutate();
      toast.success('Page moved to trash.', { id: toastId });
    } catch {
      toast.error('Error moving page to trash.', { id: toastId });
    } finally {
      setConfirmTrashOpen(false);
    }
  }, [item.id, onMutate]);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={handleOpen}>
            <ExternalLink className="mr-2 h-4 w-4" />
            <span>Open</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleOpenInNewTab}>
            <ExternalLink className="mr-2 h-4 w-4" />
            <span>Open in new tab</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            <span>Rename</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleFavoriteToggle}>
            <Star
              className={cn(
                'mr-2 h-4 w-4',
                isFavorite(item.id) && 'text-yellow-500 fill-yellow-500'
              )}
            />
            <span>{isFavorite(item.id) ? 'Unfavorite' : 'Favorite'}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setMoveOpen(true)}>
            <FolderInput className="mr-2 h-4 w-4" />
            <span>Move to...</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setCopyOpen(true)}>
            <Copy className="mr-2 h-4 w-4" />
            <span>Copy to...</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => setConfirmTrashOpen(true)}
            className="text-red-500 focus:text-red-500"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            <span>Trash</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <DeletePageDialog
        isOpen={isConfirmTrashOpen}
        onClose={() => setConfirmTrashOpen(false)}
        onConfirm={handleDelete}
        hasChildren={hasChildren}
      />

      <RenameDialog
        isOpen={isRenameOpen}
        onClose={() => setRenameOpen(false)}
        onRename={handleRename}
        initialName={item.title}
        title="Rename Page"
        description="Enter a new name for your page."
      />

      <MovePageDialog
        isOpen={isMoveOpen}
        onClose={() => setMoveOpen(false)}
        pages={[pageInfo]}
        onSuccess={() => onMutate()}
      />

      <CopyPageDialog
        isOpen={isCopyOpen}
        onClose={() => setCopyOpen(false)}
        pages={[pageInfo]}
        onSuccess={() => onMutate()}
      />
    </>
  );
}
