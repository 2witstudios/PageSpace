"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { X, Trash2, FolderInput, Copy, CheckSquare } from "lucide-react";
import { toast } from "sonner";
import { useMultiSelectStore } from "@/stores/useMultiSelectStore";
import { useShallow } from "zustand/react/shallow";
import { MovePageDialog } from "@/components/dialogs/MovePageDialog";
import { CopyPageDialog } from "@/components/dialogs/CopyPageDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

interface MultiSelectToolbarProps {
  driveId: string;
  onMutate: () => void;
}

export function MultiSelectToolbar({ driveId, onMutate }: MultiSelectToolbarProps) {
  const isMultiSelectMode = useMultiSelectStore((state) => state.isMultiSelectMode);
  const activeDriveId = useMultiSelectStore((state) => state.activeDriveId);
  const selectedPages = useMultiSelectStore(useShallow((state) => Array.from(state.selectedPages.values())));
  const selectedCount = useMultiSelectStore((state) => state.selectedPages.size);
  const exitMultiSelectMode = useMultiSelectStore((state) => state.exitMultiSelectMode);

  const [isMoveOpen, setMoveOpen] = useState(false);
  const [isCopyOpen, setCopyOpen] = useState(false);
  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Must define all hooks before any conditional returns
  const handleSuccess = useCallback(() => {
    exitMultiSelectMode();
    onMutate();
  }, [exitMultiSelectMode, onMutate]);

  const handleCancel = useCallback(() => {
    exitMultiSelectMode();
  }, [exitMultiSelectMode]);

  const handleBulkDelete = useCallback(async () => {
    setIsDeleting(true);
    const { selectedPages: currentPages } = useMultiSelectStore.getState();
    const count = currentPages.size;
    const pageIds = Array.from(currentPages.keys());
    const toastId = toast.loading(
      `Moving ${count} ${count === 1 ? "page" : "pages"} to trash...`
    );

    try {
      const response = await fetchWithAuth("/api/pages/bulk-delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageIds,
          trashChildren: true,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete pages");
      }

      toast.success(
        `Successfully moved ${count} ${count === 1 ? "page" : "pages"} to trash`,
        { id: toastId }
      );
      exitMultiSelectMode();
      onMutate();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete pages",
        { id: toastId }
      );
    } finally {
      setIsDeleting(false);
      setDeleteOpen(false);
    }
  }, [exitMultiSelectMode, onMutate]);

  // Only show toolbar for the active drive
  if (!isMultiSelectMode || activeDriveId !== driveId) {
    return null;
  }

  return (
    <>
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b px-2 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckSquare className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">
              {selectedCount} selected
            </span>
          </div>

          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMoveOpen(true)}
                  disabled={selectedCount === 0}
                  className="h-8 px-2"
                >
                  <FolderInput className="h-4 w-4" />
                  <span className="sr-only">Move</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move to...</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCopyOpen(true)}
                  disabled={selectedCount === 0}
                  className="h-8 px-2"
                >
                  <Copy className="h-4 w-4" />
                  <span className="sr-only">Copy</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy to...</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteOpen(true)}
                  disabled={selectedCount === 0}
                  className="h-8 px-2 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">Delete</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move to trash</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  className="h-8 px-2"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Cancel</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Cancel selection</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <MovePageDialog
        isOpen={isMoveOpen}
        onClose={() => setMoveOpen(false)}
        pages={selectedPages}
        onSuccess={handleSuccess}
      />

      <CopyPageDialog
        isOpen={isCopyOpen}
        onClose={() => setCopyOpen(false)}
        pages={selectedPages}
        onSuccess={handleSuccess}
      />

      <AlertDialog open={isDeleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move {selectedCount} {selectedCount === 1 ? "page" : "pages"} and all their
              children to the trash. You can restore them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Moving..." : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
