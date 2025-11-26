'use client';

import { useEffect, useMemo, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import Link from 'next/link';
import { useDriveStore } from '@/hooks/useDrive';
import { useGlobalDriveSocket } from '@/hooks/useGlobalDriveSocket';
import { Skeleton } from "@/components/ui/skeleton";
import { Drive } from "@/hooks/useDrive";
import { Folder, Trash2, MoreHorizontal, Pencil, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFileDrop } from '@/hooks/useFileDrop';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { DeleteDriveDialog } from "@/components/dialogs/DeleteDriveDialog";
import { toast } from "sonner";
import { patch, del, post } from '@/lib/auth-fetch';

const DriveListItem = ({
  drive,
  isActive,
  canManage,
  onRename,
  onDelete,
  onRestore,
  onPermanentDelete,
  onFilesUploaded
}: {
  drive: Drive;
  isActive: boolean;
  canManage: boolean;
  onRename?: (drive: Drive) => void;
  onDelete?: (drive: Drive) => void;
  onRestore?: (drive: Drive) => void;
  onPermanentDelete?: (drive: Drive) => void;
  onFilesUploaded?: () => void;
}) => {
  const [isHovered, setIsHovered] = useState(false);
  
  // File drop handling for individual drives
  const {
    isDraggingFiles,
    isUploading,
    uploadProgress,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleFileDrop
  } = useFileDrop({
    driveId: drive.id,
    parentId: null,
    onUploadComplete: onFilesUploaded
  });
  
  return (
    <div 
      className="group relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => handleFileDrop(e as React.DragEvent)}
    >
      <div
        className={cn(
          "flex items-center gap-2 p-2 rounded-md text-sm font-medium transition-all",
          isActive ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent hover:text-accent-foreground",
          isDraggingFiles && !drive.isTrashed && "bg-primary/10 border border-dashed border-primary"
        )}
      >
        <Link href={`/dashboard/${drive.id}`} className="flex items-center gap-2 flex-1">
          <Folder className="h-4 w-4" />
          <span className="truncate">{drive.name}</span>
        </Link>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-6 w-6 transition-opacity",
                  isHovered ? "opacity-100" : "opacity-0"
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {drive.isTrashed ? (
                <>
                  {onRestore && (
                    <DropdownMenuItem onSelect={() => onRestore(drive)}>
                      <Undo2 className="mr-2 h-4 w-4" />
                      <span>Restore</span>
                    </DropdownMenuItem>
                  )}
                  {onPermanentDelete && (
                    <DropdownMenuItem
                      onSelect={() => onPermanentDelete(drive)}
                      className="text-red-500 focus:text-red-500"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      <span>Delete Permanently</span>
                    </DropdownMenuItem>
                  )}
                </>
              ) : (
                <>
                  {onRename && (
                    <DropdownMenuItem onSelect={() => onRename(drive)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      <span>Rename</span>
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem
                      onSelect={() => onDelete(drive)}
                      className="text-red-500 focus:text-red-500"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      <span>Move to Trash</span>
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      
      {/* Upload progress indicator for this drive */}
      {isUploading && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-md p-2 shadow-sm z-50">
          <p className="text-xs font-medium mb-1">Uploading...</p>
          <div className="h-1 bg-secondary rounded-full overflow-hidden">
            <div 
              className="h-full bg-primary transition-all duration-300" 
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default function DriveList() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();

  // Use selective Zustand subscriptions to prevent unnecessary re-renders
  const drives = useDriveStore(state => state.drives);
  const fetchDrives = useDriveStore(state => state.fetchDrives);
  const isLoading = useDriveStore(state => state.isLoading);
  const setCurrentDrive = useDriveStore(state => state.setCurrentDrive);
  const currentDriveId = useDriveStore(state => state.currentDriveId);

  const [renameDialogState, setRenameDialogState] = useState<{ isOpen: boolean; drive: Drive | null }>({ isOpen: false, drive: null });
  const [deleteDialogState, setDeleteDialogState] = useState<{ isOpen: boolean; drive: Drive | null }>({ isOpen: false, drive: null });
  
  // Enable real-time drive updates
  useGlobalDriveSocket();

  const { driveId } = params;
  const urlDriveId = Array.isArray(driveId) ? driveId[0] : driveId;
  const isTrashView = pathname.includes('/trash');

  useEffect(() => {
    if (urlDriveId) {
        const currentDrive = drives.find(d => d.id === urlDriveId);
        if (currentDrive) {
            setCurrentDrive(currentDrive.id);
        }
    }
  }, [urlDriveId, drives, setCurrentDrive]);

  useEffect(() => {
    fetchDrives(true); // Include trash to show in trash section
  }, [fetchDrives]);

  const handleRenameDrive = async (newName: string) => {
    if (!renameDialogState.drive) return;
    const toastId = toast.loading("Renaming drive...");
    try {
      await patch(`/api/drives/${renameDialogState.drive.id}`, { name: newName });
      await fetchDrives(true, true); // Force refresh
      toast.success("Drive renamed.", { id: toastId });
    } catch {
      toast.error("Error renaming drive.", { id: toastId });
    } finally {
      setRenameDialogState({ isOpen: false, drive: null });
    }
  };

  const handleDeleteDrive = async () => {
    if (!deleteDialogState.drive) return;
    const toastId = toast.loading("Moving drive to trash...");
    try {
      await del(`/api/drives/${deleteDialogState.drive.id}`);
      await fetchDrives(true, true); // Force refresh
      if (currentDriveId === deleteDialogState.drive.id) {
        router.push('/dashboard');
      }
      toast.success("Drive moved to trash.", { id: toastId });
    } catch {
      toast.error("Error moving drive to trash.", { id: toastId });
    } finally {
      setDeleteDialogState({ isOpen: false, drive: null });
    }
  };

  const handleRestoreDrive = async (drive: Drive) => {
    const toastId = toast.loading("Restoring drive...");
    try {
      await post(`/api/drives/${drive.id}/restore`);
      await fetchDrives(true, true); // Force refresh
      toast.success("Drive restored.", { id: toastId });
    } catch {
      toast.error("Error restoring drive.", { id: toastId });
    }
  };

  const handlePermanentDelete = async (drive: Drive) => {
    const toastId = toast.loading("Permanently deleting drive...");
    try {
      await del(`/api/trash/drives/${drive.id}`);
      await fetchDrives(true, true); // Force refresh
      toast.success("Drive permanently deleted.", { id: toastId });
    } catch {
      toast.error("Error permanently deleting drive.", { id: toastId });
    }
  };

  const { ownedDrives, sharedDrives, trashedDrives } = useMemo(() => {
    const owned: Drive[] = [];
    const shared: Drive[] = [];
    const trashed: Drive[] = [];
    drives.forEach((d) => {
      if (d.isTrashed && d.isOwned) {
        trashed.push(d);
      } else if (d.isOwned) {
        owned.push(d);
      } else if (!d.isTrashed) {
        shared.push(d);
      }
    });
    return { ownedDrives: owned, sharedDrives: shared, trashedDrives: trashed };
  }, [drives]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {ownedDrives.length > 0 && (
        <div>
          <h3 className="px-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">My Drives</h3>
          <div className="space-y-1">
            {ownedDrives.map((drive) => (
              <DriveListItem
                key={drive.id}
                drive={drive}
                isActive={!isTrashView && drive.id === urlDriveId}
                canManage={true}
                onRename={() => setRenameDialogState({ isOpen: true, drive })}
                onDelete={() => setDeleteDialogState({ isOpen: true, drive })}
                onFilesUploaded={() => fetchDrives(true, true)}
              />
            ))}
          </div>
        </div>
      )}
      {sharedDrives.length > 0 && (
        <div>
          <h3 className="px-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Shared Drives</h3>
          <div className="space-y-1">
            {sharedDrives.map((drive) => (
              <DriveListItem
                key={drive.id}
                drive={drive}
                isActive={!isTrashView && drive.id === urlDriveId}
                canManage={drive.role === 'ADMIN'}
                onRename={drive.role === 'ADMIN' ? () => setRenameDialogState({ isOpen: true, drive }) : undefined}
                onDelete={drive.role === 'ADMIN' ? () => setDeleteDialogState({ isOpen: true, drive }) : undefined}
                onFilesUploaded={() => fetchDrives(true, true)}
              />
            ))}
          </div>
        </div>
      )}
       {drives.length === 0 && (
         <p className="p-2 text-sm text-gray-500">No drives found.</p>
      )}
      {trashedDrives.length > 0 && (
        <div>
          <h3 className="px-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Trash</h3>
          <div className="space-y-1">
            {trashedDrives.map((drive) => (
              <DriveListItem
                key={drive.id}
                drive={drive}
                isActive={false}
                canManage={true}
                onRestore={handleRestoreDrive}
                onPermanentDelete={handlePermanentDelete}
              />
            ))}
          </div>
        </div>
      )}
      {urlDriveId && (
        <div>
          <Link href={`/dashboard/${urlDriveId}/trash`}>
            <div
              className={cn(
                "flex items-center gap-2 p-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                isTrashView && "bg-accent text-accent-foreground"
              )}
            >
              <Trash2 className="h-4 w-4" />
              <span className="truncate">Page Trash</span>
            </div>
          </Link>
        </div>
      )}
      <RenameDialog
        isOpen={renameDialogState.isOpen}
        onClose={() => setRenameDialogState({ isOpen: false, drive: null })}
        onRename={handleRenameDrive}
        initialName={renameDialogState.drive?.name || ""}
        title="Rename Drive"
        description="Enter a new name for your drive."
      />
      <DeleteDriveDialog
        isOpen={deleteDialogState.isOpen}
        onClose={() => setDeleteDialogState({ isOpen: false, drive: null })}
        onConfirm={handleDeleteDrive}
        driveName={deleteDialogState.drive?.name || ""}
      />
    </div>
  );
}