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

interface DeletePageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (trashChildren: boolean) => void;
  hasChildren: boolean;
}

export function DeletePageDialog({
  isOpen,
  onClose,
  onConfirm,
  hasChildren,
}: DeletePageDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action will move the page to the trash. You can restore it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {hasChildren ? (
            <>
              <AlertDialogAction onClick={() => onConfirm(false)}>
                Move Folder Only
              </AlertDialogAction>
              <AlertDialogAction onClick={() => onConfirm(true)}>
                Move Folder and All Contents
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={() => onConfirm(false)}>
              Move to Trash
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}