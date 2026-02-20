"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Folder, Pencil, Star, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { DeleteDriveDialog } from "@/components/dialogs/DeleteDriveDialog";
import { useFavorites } from "@/hooks/useFavorites";
import { useDriveStore, type Drive } from "@/hooks/useDrive";
import { patch, del } from "@/lib/auth/auth-fetch";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DriveContextMenuProps {
  drive: Drive;
  children: React.ReactNode;
}

export function DriveContextMenu({ drive, children }: DriveContextMenuProps) {
  const router = useRouter();
  const [isRenameOpen, setRenameOpen] = useState(false);
  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { isFavorite, addFavorite, removeFavorite } = useFavorites();
  const updateDrive = useDriveStore((state) => state.updateDrive);
  const removeDriveFromStore = useDriveStore((state) => state.removeDrive);

  const handleOpen = () => {
    router.push(`/dashboard/${drive.id}`);
  };

  const handleRename = async (newName: string) => {
    const toastId = toast.loading("Renaming drive...");
    try {
      await patch(`/api/drives/${drive.id}`, { name: newName });
      updateDrive(drive.id, { name: newName });
      toast.success("Drive renamed.", { id: toastId });
    } catch {
      toast.error("Error renaming drive.", { id: toastId });
    } finally {
      setRenameOpen(false);
    }
  };

  const handleFavoriteToggle = async () => {
    const isCurrentlyFavorite = isFavorite(drive.id, "drive");
    const action = isCurrentlyFavorite ? removeFavorite : addFavorite;
    const actionVerb = isCurrentlyFavorite ? "Removing from" : "Adding to";
    const toastId = toast.loading(`${actionVerb} favorites...`);
    try {
      await action(drive.id, "drive");
      toast.success(
        `Drive ${isCurrentlyFavorite ? "removed from" : "added to"} favorites.`,
        { id: toastId }
      );
    } catch {
      toast.error("Error updating favorites.", { id: toastId });
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    const toastId = toast.loading("Moving drive to trash...");
    try {
      await del(`/api/drives/${drive.id}`);
      removeDriveFromStore(drive.id);
      toast.success("Drive moved to trash.", { id: toastId });
    } catch {
      toast.error("Error moving drive to trash.", { id: toastId });
    } finally {
      setIsDeleting(false);
      setDeleteOpen(false);
    }
  };

  const driveIsFavorite = isFavorite(drive.id, "drive");
  const canManage = drive.role === "OWNER" || drive.role === "ADMIN";

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={handleOpen}>
            <Folder className="mr-2 h-4 w-4" />
            <span>Open</span>
          </ContextMenuItem>
          {canManage && (
            <ContextMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" />
              <span>Rename</span>
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={handleFavoriteToggle}>
            <Star
              className={cn(
                "mr-2 h-4 w-4",
                driveIsFavorite && "text-yellow-500 fill-yellow-500"
              )}
            />
            <span>{driveIsFavorite ? "Unfavorite" : "Favorite"}</span>
          </ContextMenuItem>
          {canManage && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => setDeleteOpen(true)}
                className="text-red-500 focus:text-red-500"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Move to Trash</span>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <RenameDialog
        isOpen={isRenameOpen}
        onClose={() => setRenameOpen(false)}
        onRename={handleRename}
        initialName={drive.name}
        title="Rename Drive"
        description="Enter a new name for your drive."
      />

      <DeleteDriveDialog
        isOpen={isDeleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        driveName={drive.name}
        isDeleting={isDeleting}
      />
    </>
  );
}
