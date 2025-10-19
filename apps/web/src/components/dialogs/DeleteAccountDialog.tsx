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

interface DeleteAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (emailConfirmation: string) => void;
  userEmail: string;
  isDeleting: boolean;
  soloDrivesCount: number;
}

export function DeleteAccountDialog({
  isOpen,
  onClose,
  onConfirm,
  userEmail,
  isDeleting,
  soloDrivesCount,
}: DeleteAccountDialogProps) {
  const [emailConfirmation, setEmailConfirmation] = useState("");

  const isEmailMatch = emailConfirmation.trim().toLowerCase() === userEmail.toLowerCase();

  const handleConfirm = () => {
    if (isEmailMatch) {
      onConfirm(emailConfirmation);
    }
  };

  const handleClose = () => {
    if (!isDeleting) {
      setEmailConfirmation("");
      onClose();
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Your Account?</AlertDialogTitle>
          <AlertDialogDescription>
            This action is permanent and cannot be undone. All your data will be permanently deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <p className="font-semibold mb-2">Warning:</p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                {soloDrivesCount > 0 && (
                  <li>{soloDrivesCount} drive{soloDrivesCount !== 1 ? 's' : ''} where you&apos;re the only member will be automatically deleted</li>
                )}
                <li>All your data, messages, and content will be permanently lost</li>
                <li>This action cannot be reversed</li>
              </ul>
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="email-confirmation">
              Type your email address <strong>{userEmail}</strong> to confirm:
            </Label>
            <Input
              id="email-confirmation"
              type="email"
              value={emailConfirmation}
              onChange={(e) => setEmailConfirmation(e.target.value)}
              placeholder="Enter your email address"
              disabled={isDeleting}
              autoComplete="off"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isEmailMatch || isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting Account..." : "Delete Account Permanently"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
