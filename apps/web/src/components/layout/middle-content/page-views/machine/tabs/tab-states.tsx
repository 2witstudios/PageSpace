"use client";

/**
 * The Machine page's shared loading / error / empty vocabulary (Phase 4).
 *
 * The four tabs were built in isolation and each grew its own treatment of the
 * same three moments — four spinners, four error rows, four ways of saying
 * "there's nothing here". These are those moments, factored once.
 *
 * The split is by PLACE, not by tab: a state rendered in an inner sidebar is a
 * compact row (it lives inside a 16rem column, beside tree rows), and a state
 * rendered in a main pane is a centred block that owns the whole area. Every tab
 * has both, so every tab reaches for both.
 *
 * The SIDEBAR half now lives in `components/layout/left-sidebar/sidebar-states.tsx`
 * — it outgrew this page when the Agents surface's sidebar needed the same rows,
 * so it moved rather than being copied. This module keeps the pane half and
 * builds on the same `Spinner`/tone primitives, which is what keeps the two
 * halves visually one vocabulary.
 *
 * What is deliberately NOT unified is the WORDS. "This branch hasn't been checked
 * out yet", "No uncommitted changes on main" and "Connecting…" are three different
 * facts about the world, and flattening them into one "Nothing to show" would
 * destroy the only information these states carry. Callers pass their own copy;
 * this module owns the shape, the spinner, and the tone.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Spinner, toneClass, type NoticeProps } from '@/components/layout/left-sidebar/sidebar-states';

// Re-exported, not redefined: the pane tabs that reach for a bare spinner
// (DiffTab, DiffFileCard, SettingsTab) still get the app's one spinner. The
// sidebar rows are NOT re-exported — their consumers import them from the
// module that owns them, so there is one obvious place to find them.
export { Spinner } from '@/components/layout/left-sidebar/sidebar-states';

/* -------------------------------------------------------------------------- */
/*  Main-pane states — centred blocks that own the whole pane.                 */
/* -------------------------------------------------------------------------- */

export function PaneLoading({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Spinner />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export function PaneNotice({
  title,
  description,
  tone = 'muted',
  icon,
  actionLabel,
  onAction,
  children,
  testId,
}: NoticeProps & { icon?: ReactNode }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid={testId}
    >
      {icon}
      <p className={cn('max-w-md text-sm font-medium', toneClass(tone))}>{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {actionLabel && onAction && (
        // Same zero-arg wrapping as SidebarNotice, and for the same reason.
        <Button type="button" variant="outline" size="sm" onClick={() => onAction()}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
