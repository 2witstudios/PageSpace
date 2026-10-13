import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/retained/components/ui/alert-dialog";

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
      <AlertDialogContent className="sm:max-w-[480px] rounded-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            {hasChildren
              ? "This will move the page and everything inside it to the trash. You can restore it later, or choose to keep the contents by moving the page only."
              : "This action will move the page to the trash. You can restore it later."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {hasChildren ? (
            <>
              <AlertDialogAction
                onClick={() => onConfirm(false)}
                className="border border-border bg-transparent text-foreground hover:bg-muted"
              >
                Move Page Only
              </AlertDialogAction>
              <AlertDialogAction
                onClick={() => onConfirm(true)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Move Page and All Contents
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction
              onClick={() => onConfirm(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Move to Trash
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}