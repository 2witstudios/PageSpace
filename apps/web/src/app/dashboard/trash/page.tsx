"use client";

import { useState, useEffect } from "react";
import { useDriveStore } from "@/hooks/useDrive";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { post, del } from '@/lib/auth/auth-fetch';
import { 
  Card, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Undo2, Trash2, HardDrive } from "lucide-react";
import { DeleteDriveDialog } from "@/components/dialogs/DeleteDriveDialog";
import { Drive } from "@pagespace/lib";

export default function GlobalTrashPage() {
  const { drives, fetchDrives } = useDriveStore();
  const { user } = useAuth();
  const [deleteDialogState, setDeleteDialogState] = useState<{ isOpen: boolean; drive: Drive | null }>({ isOpen: false, drive: null });

  // Filter trashed drives owned by the user
  const trashedDrives = drives.filter(d => d.isTrashed && d.ownerId === user?.id);

  useEffect(() => {
    fetchDrives(true); // Include trashed drives
  }, [fetchDrives]);


  const handleRestoreDrive = async (drive: Drive) => {
    const toastId = toast.loading("Restoring drive...");
    try {
      await post(`/api/drives/${drive.id}/restore`);
      await fetchDrives();
      toast.success("Drive restored.", { id: toastId });
    } catch {
      toast.error("Error restoring drive.", { id: toastId });
    }
  };

  const handlePermanentDeleteDrive = async () => {
    if (!deleteDialogState.drive) return;
    const toastId = toast.loading("Permanently deleting drive...");
    try {
      await del(`/api/trash/drives/${deleteDialogState.drive.id}`);
      await fetchDrives();
      toast.success("Drive permanently deleted.", { id: toastId });
    } catch {
      toast.error("Error permanently deleting drive.", { id: toastId });
    } finally {
      setDeleteDialogState({ isOpen: false, drive: null });
    }
  };


  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Trashed Drives</h1>
        
        <div className="space-y-2">
          {trashedDrives.length > 0 ? (
            trashedDrives.map((drive) => (
              <Card key={drive.id}>
                <CardHeader className="flex flex-row items-center justify-between py-4">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-muted-foreground" />
                    <CardTitle className="text-base">{drive.name}</CardTitle>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => handleRestoreDrive(drive)}>
                        <Undo2 className="mr-2 h-4 w-4" />
                        Restore
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setDeleteDialogState({ isOpen: true, drive })}
                        className="text-red-500 focus:text-red-500"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Permanently
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
              </Card>
            ))
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No trashed drives
            </div>
          )}
        </div>
      
        <DeleteDriveDialog
          isOpen={deleteDialogState.isOpen}
          onClose={() => setDeleteDialogState({ isOpen: false, drive: null })}
          onConfirm={handlePermanentDeleteDrive}
          driveName={deleteDialogState.drive?.name || ""}
        />
      </div>
    </div>
  );
}