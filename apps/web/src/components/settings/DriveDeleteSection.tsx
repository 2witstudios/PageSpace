'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/useToast';
import { del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { DeleteDriveDialog } from '@/components/dialogs/DeleteDriveDialog';
import { useDriveStore } from '@/hooks/useDrive';

interface DriveDeleteSectionProps {
  driveId: string;
  driveName: string;
}

export function DriveDeleteSection({ driveId, driveName }: DriveDeleteSectionProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [memberCount, setMemberCount] = useState(1);
  const { toast } = useToast();
  const router = useRouter();
  const removeDrive = useDriveStore((state) => state.removeDrive);

  useEffect(() => {
    const fetchMemberCount = async () => {
      try {
        const response = await fetchWithAuth(`/api/drives/${driveId}/members`);
        if (response.ok) {
          const data = await response.json();
          setMemberCount(data.members?.length ?? 1);
        }
      } catch {
        // Silently fail - member count is optional
      }
    };
    fetchMemberCount();
  }, [driveId]);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await del(`/api/drives/${driveId}`);

      toast({
        title: 'Drive deleted',
        description: 'The drive has been moved to trash.',
      });

      // Remove from local store
      removeDrive(driveId);

      // Navigate to dashboard
      router.push('/dashboard');
    } catch (error) {
      console.error('Error deleting drive:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete drive. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
      setShowDialog(false);
    }
  };

  return (
    <>
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="w-5 h-5" />
            Delete Drive
          </CardTitle>
          <CardDescription>
            Permanently delete this drive and all its contents. This action moves the drive to trash
            where it can be restored within 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              <p className="mb-2">Deleting this drive will:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Move all pages and content to trash</li>
                <li>Revoke access for all members</li>
                <li>Stop all AI agents and automations</li>
              </ul>
            </div>
            <Button
              variant="destructive"
              onClick={() => setShowDialog(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete Drive
            </Button>
          </div>
        </CardContent>
      </Card>

      <DeleteDriveDialog
        isOpen={showDialog}
        onClose={() => setShowDialog(false)}
        onConfirm={handleDelete}
        driveName={driveName}
        isDeleting={isDeleting}
        memberCount={memberCount}
      />
    </>
  );
}
