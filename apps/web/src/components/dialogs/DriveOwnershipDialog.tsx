import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Loader2, Users, Trash2, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { post } from '@/lib/auth-fetch';

interface Admin {
  id: string;
  name: string;
  email: string;
}

interface MultiMemberDrive {
  id: string;
  name: string;
  memberCount: number;
  admins: Admin[];
}

interface DriveOwnershipDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAllDrivesHandled: () => void;
  multiMemberDrives: MultiMemberDrive[];
}

export function DriveOwnershipDialog({
  isOpen,
  onClose,
  onAllDrivesHandled,
  multiMemberDrives: initialDrives,
}: DriveOwnershipDialogProps) {
  const [remainingDrives, setRemainingDrives] = useState(initialDrives);
  const [selectedNewOwners, setSelectedNewOwners] = useState<Record<string, string>>({});
  const [processingDrives, setProcessingDrives] = useState<Set<string>>(new Set());

  const handleTransfer = async (driveId: string, driveName: string) => {
    const newOwnerId = selectedNewOwners[driveId];
    if (!newOwnerId) {
      toast.error("Please select a new owner");
      return;
    }

    setProcessingDrives(prev => new Set(prev).add(driveId));

    try {
      await post("/api/account/handle-drive", {
        driveId,
        action: "transfer",
        newOwnerId,
      });

      toast.success(`Transferred ownership of "${driveName}"`);

      // Remove this drive from the list
      const updated = remainingDrives.filter(d => d.id !== driveId);
      setRemainingDrives(updated);

      // Clear selected owner for this drive
      setSelectedNewOwners(prev => {
        const newState = { ...prev };
        delete newState[driveId];
        return newState;
      });

      // If all drives handled, proceed to deletion
      if (updated.length === 0) {
        onAllDrivesHandled();
      }
    } catch (error) {
      console.error("Transfer error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to transfer ownership");
    } finally {
      setProcessingDrives(prev => {
        const newSet = new Set(prev);
        newSet.delete(driveId);
        return newSet;
      });
    }
  };

  const handleDelete = async (driveId: string, driveName: string) => {
    setProcessingDrives(prev => new Set(prev).add(driveId));

    try {
      await post("/api/account/handle-drive", {
        driveId,
        action: "delete",
      });

      toast.success(`Deleted drive "${driveName}"`);

      // Remove this drive from the list
      const updated = remainingDrives.filter(d => d.id !== driveId);
      setRemainingDrives(updated);

      // If all drives handled, proceed to deletion
      if (updated.length === 0) {
        onAllDrivesHandled();
      }
    } catch (error) {
      console.error("Delete error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete drive");
    } finally {
      setProcessingDrives(prev => {
        const newSet = new Set(prev);
        newSet.delete(driveId);
        return newSet;
      });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Handle Drive Ownership</DialogTitle>
          <DialogDescription>
            Before deleting your account, you must transfer or delete drives with other members.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p className="font-semibold mb-2">You own {remainingDrives.length} drive{remainingDrives.length !== 1 ? 's' : ''} with other members:</p>
            <p className="text-sm">
              For each drive, either transfer ownership to an admin or delete the drive entirely.
            </p>
          </AlertDescription>
        </Alert>

        <div className="space-y-4 py-4">
          {remainingDrives.map((drive) => {
            const isProcessing = processingDrives.has(drive.id);
            const hasAdmins = drive.admins.length > 0;

            return (
              <div key={drive.id} className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold">{drive.name}</h3>
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {drive.memberCount} member{drive.memberCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  {hasAdmins ? (
                    <div className="flex gap-2">
                      <Select
                        value={selectedNewOwners[drive.id] || ""}
                        onValueChange={(value) =>
                          setSelectedNewOwners(prev => ({ ...prev, [drive.id]: value }))
                        }
                        disabled={isProcessing}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Select new owner (admin)" />
                        </SelectTrigger>
                        <SelectContent>
                          {drive.admins.map((admin) => (
                            <SelectItem key={admin.id} value={admin.id}>
                              {admin.name} ({admin.email})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        onClick={() => handleTransfer(drive.id, drive.name)}
                        disabled={!selectedNewOwners[drive.id] || isProcessing}
                        size="sm"
                      >
                        {isProcessing ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <ArrowRightLeft className="h-4 w-4 mr-2" />
                            Transfer
                          </>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <Alert>
                      <AlertDescription className="text-sm">
                        No admins available to transfer to. You must delete this drive.
                      </AlertDescription>
                    </Alert>
                  )}

                  <Button
                    onClick={() => handleDelete(drive.id, drive.name)}
                    disabled={isProcessing}
                    variant="destructive"
                    size="sm"
                    className="w-full"
                  >
                    {isProcessing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete Drive
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={processingDrives.size > 0}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
