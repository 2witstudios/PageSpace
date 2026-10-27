'use client';

import React from 'react';
import { ClipboardList, ClipboardX } from 'lucide-react';

interface PlanBindingRendererProps {
  bound: boolean;
  success?: boolean;
  title?: string;
  error?: string;
}

/**
 * A completed `set_plan` / `clear_plan` call.
 *
 * Informational only — the PlanChip in the chat header is the live, clickable
 * surface for the binding, and it reads the persisted state rather than this
 * message. Keeping this renderer inert avoids two controls disagreeing about
 * the same fact when the tool call scrolls into history.
 */
export function PlanBindingRenderer({ bound, success = true, title, error }: PlanBindingRendererProps) {
  const Icon = bound ? ClipboardList : ClipboardX;

  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">
        {!success ? (
          <>Could not update the plan for this chat{error ? `: ${error}` : ''}</>
        ) : bound ? (
          <>
            Working against the plan{' '}
            <span className="font-medium text-foreground">{title ?? 'for this chat'}</span>
          </>
        ) : (
          <>Cleared the plan for this chat</>
        )}
      </span>
    </div>
  );
}
