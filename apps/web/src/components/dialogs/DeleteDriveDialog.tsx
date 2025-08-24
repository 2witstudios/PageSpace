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

interface DeleteDriveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  driveName: string;
}

export function DeleteDriveDialog({
  isOpen,
  onClose,
  onConfirm,
  driveName,
}: DeleteDriveDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Drive &quot;{driveName}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            This action will move the drive and all its contents to the trash. 
            You can restore it later from the trash if needed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Move to Trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}