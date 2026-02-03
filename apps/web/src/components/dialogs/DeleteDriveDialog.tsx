import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

interface DeleteDriveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  driveName: string;
  isDeleting?: boolean;
  memberCount?: number;
}

export function DeleteDriveDialog({
  isOpen,
  onClose,
  onConfirm,
  driveName,
  isDeleting = false,
  memberCount = 1,
}: DeleteDriveDialogProps) {
  const [nameConfirmation, setNameConfirmation] = useState("");

  const isNameMatch = nameConfirmation.trim().toLowerCase() === driveName.toLowerCase();

  const handleConfirm = () => {
    if (isNameMatch) {
      onConfirm();
    }
  };

  const handleClose = () => {
    if (!isDeleting) {
      setNameConfirmation("");
      onClose();
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Drive?</AlertDialogTitle>
          <AlertDialogDescription>
            This will move the drive to trash. You can restore it within 30 days.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <p className="font-semibold mb-2">Warning:</p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                {memberCount > 1 && (
                  <li>{memberCount - 1} other member{memberCount > 2 ? 's' : ''} will lose access to this drive</li>
                )}
                <li>All pages and content in this drive will be moved to trash</li>
                <li>The drive can be restored from trash within 30 days</li>
              </ul>
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="drive-name-confirmation">
              Type the drive name <strong>{driveName}</strong> to confirm:
            </Label>
            <Input
              id="drive-name-confirmation"
              type="text"
              value={nameConfirmation}
              onChange={(e) => setNameConfirmation(e.target.value)}
              placeholder="Enter drive name"
              disabled={isDeleting}
              autoComplete="off"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isNameMatch || isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting Drive..." : "Delete Drive"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
