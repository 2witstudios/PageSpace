"use client";

import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/** Hover-reveal destructive remove (X) button shared across the Machine tree —
 * project/branch rows (MachineTree's TreeRow) and workspace leaves (the
 * Terminal tab). Kept in the tab order and revealed on keyboard focus (opacity,
 * not visibility) so keyboard users can reach it — the same chrome-free reveal
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

/** The non-destructive sibling of {@link RemoveButton} — same hover/focus reveal
 * chrome, for a row's "add a child at this scope" affordance (Machine [+] adds
 * a project, Project [+] adds a branch, any node's [+] starts a new workspace).
 * Icons convey type; this is deliberately just the container button — callers
 * pass whichever icon fits (`Plus` for structural adds). */
export function AddButton({ onClick, label, icon, disabled }: { onClick(): void; label: string; icon: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="size-5 shrink-0 rounded-sm text-muted-foreground opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0"
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  );
}
