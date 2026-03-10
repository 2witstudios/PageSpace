"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Loader2 } from "lucide-react";
import { del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from "sonner";
import { DeleteAccountDialog } from "@/components/dialogs/DeleteAccountDialog";
import { DriveOwnershipDialog } from "@/components/dialogs/DriveOwnershipDialog";

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

interface DangerZoneSectionProps {
  userEmail: string;
}

export function DangerZoneSection({ userEmail }: DangerZoneSectionProps) {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isOwnershipDialogOpen, setIsOwnershipDialogOpen] = useState(false);
  const [multiMemberDrives, setMultiMemberDrives] = useState<MultiMemberDrive[]>([]);
  const [soloDrivesCount, setSoloDrivesCount] = useState(0);

  const handleInitiateDeletion = async () => {
    try {
      const response = await fetchWithAuth("/api/account/drives-status");
      if (!response.ok) throw new Error("Failed to fetch drives status");
      const data = await response.json();
      setSoloDrivesCount(data.soloDrives.length);
      setMultiMemberDrives(data.multiMemberDrives);
      if (data.multiMemberDrives.length > 0) {
        setIsOwnershipDialogOpen(true);
      } else {
        setIsDeleteDialogOpen(true);
      }
    } catch {
      toast.error("Failed to check drive ownership status");
    }
  };

  const handleAllDrivesHandled = () => {
    setIsOwnershipDialogOpen(false);
    setMultiMemberDrives([]);
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteAccount = async (emailConfirmation: string) => {
    setIsDeleting(true);
    try {
      await del("/api/account", { emailConfirmation });
      setTimeout(() => { window.location.href = "/"; }, 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete account");
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <>
      <Card className="border-destructive/50 mb-6">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Irreversible actions for your account</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Account deletion is permanent and cannot be undone. All your data will be permanently deleted.
            </AlertDescription>
          </Alert>
          <Button
            variant="destructive"
            className="mt-4"
            onClick={handleInitiateDeletion}
            disabled={isDeleting}
          >
            {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Delete Account
          </Button>
        </CardContent>
      </Card>

      <DriveOwnershipDialog
        isOpen={isOwnershipDialogOpen}
        onClose={() => setIsOwnershipDialogOpen(false)}
        onAllDrivesHandled={handleAllDrivesHandled}
        multiMemberDrives={multiMemberDrives}
      />

      <DeleteAccountDialog
        isOpen={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleDeleteAccount}
        userEmail={userEmail}
        isDeleting={isDeleting}
        soloDrivesCount={soloDrivesCount}
      />
    </>
  );
}
