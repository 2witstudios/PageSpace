"use client";

import { X } from 'lucide-react';

/** Hover-reveal destructive remove (X) button shared across the Machine tree —
 * project/branch rows (MachineTree's TreeRow) and session leaves (the Terminal
 * tab). Kept in the tab order and revealed on keyboard focus (opacity, not
 * visibility) so keyboard users can reach it — the same chrome-free reveal
 * pattern as TerminalPanes' pane controls. */
export default function RemoveButton({ onClick, label }: { onClick(): void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="size-5 shrink-0 rounded-sm text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      title={label}
      aria-label={label}
    >
      <X className="mx-auto size-3.5" />
    </button>
  );
}
