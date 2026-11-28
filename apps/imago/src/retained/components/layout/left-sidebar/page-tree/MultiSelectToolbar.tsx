"use client";

import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMultiSelectStore } from "@/retained/stores/useMultiSelectStore";
import { MovePageDialog } from "@/retained/components/dialogs/MovePageDialog";
import { CopyPageDialog } from "@/retained/components/dialogs/CopyPageDialog";
import { MultiSelectToolbar as SelectionToolbar } from "@/ui/files/multi-select/multi-select-toolbar";
import { useMultiSelection } from "@/ui/files/multi-select/use-multi-select";

interface MultiSelectToolbarProps {
  driveId: string;
  onMutate: () => void;
}

/**
 * The tree's multi-select toolbar: the Imago toolbar ("<n> selected", Move, Copy, Delete,
 * Cancel) over the vendored selection store, with the Move and Copy dialogs for the selection.
 */
export function MultiSelectToolbar({ driveId, onMutate }: MultiSelectToolbarProps) {
  const selection = useMultiSelection(driveId);
  const selectedPages = useMultiSelectStore(useShallow((state) => Array.from(state.selectedPages.values())));
  const exitMultiSelectMode = useMultiSelectStore((state) => state.exitMultiSelectMode);
  const [isMoveOpen, setMoveOpen] = useState(false);
  const [isCopyOpen, setCopyOpen] = useState(false);

  const handleSuccess = () => {
    exitMultiSelectMode();
    onMutate();
  };

  return (
    <>
      <SelectionToolbar
        selection={selection}
        onMove={() => setMoveOpen(true)}
        onCopy={() => setCopyOpen(true)}
        onTrashed={onMutate}
      />
      <MovePageDialog isOpen={isMoveOpen} onClose={() => setMoveOpen(false)} pages={selectedPages} onSuccess={handleSuccess} />
      <CopyPageDialog isOpen={isCopyOpen} onClose={() => setCopyOpen(false)} pages={selectedPages} onSuccess={handleSuccess} />
    </>
  );
}
