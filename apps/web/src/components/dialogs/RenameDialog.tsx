import { useState, useEffect, useId } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditingSession } from "@/stores/useEditingSession";

interface RenameDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onRename: (newName: string) => void;
  initialName: string;
  title: string;
  description: string;
}

export function RenameDialog({
  isOpen,
  onClose,
  onRename,
  initialName,
  title,
  description,
}: RenameDialogProps) {
  const [name, setName] = useState(initialName);
  const inputId = useId();

  useEffect(() => {
    setName(initialName);
  }, [initialName, isOpen]);

  // Refresh protection while the dialog is open (CLAUDE.md): an SWR
  // revalidation or an auth refresh landing mid-type would otherwise be free to
  // re-render this input out from under a half-typed name. Matches what
  // `DriveEnvNameDialog` already does for the environment rename beside it.
  useEditingSession(`rename-dialog-${inputId}`, isOpen, 'form', { componentName: 'RenameDialog' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onRename(name);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">
                Name
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="col-span-3"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}