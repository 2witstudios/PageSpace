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

interface BatchDeleteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pageCount: number;
  pageNames?: string[];
}

export function BatchDeleteDialog({
  isOpen,
  onClose,
  onConfirm,
  pageCount,
  pageNames,
}: BatchDeleteDialogProps) {
  const showNames = pageNames && pageNames.length > 0 && pageNames.length <= 5;

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move {pageCount} pages to trash?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This action will move {pageCount} selected page{pageCount !== 1 ? "s" : ""} to the trash.
                You can restore them later.
              </p>
              {showNames && (
                <ul className="mt-2 list-disc list-inside text-sm text-muted-foreground">
                  {pageNames.map((name, index) => (
                    <li key={index} className="truncate">{name}</li>
                  ))}
                </ul>
              )}
              {pageNames && pageNames.length > 5 && (
                <p className="text-sm text-muted-foreground">
                  and {pageNames.length - 5} more...
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Move to Trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
