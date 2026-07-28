"use client";

/**
 * The app's compact loading / error / empty vocabulary for LEFT SIDEBARS.
 *
 * These started life inside the Machine page's tab folder, where they served
 * that page's inner sidebars. They are here now because the Agents surface's
 * sidebar needs the same three moments and the Machine page is on its way out —
 * moved rather than copied, so there is still exactly one spinner row and one
 * notice row in the app, and so the Machine tabs' remaining pane-states
 * (`machine/tabs/tab-states.tsx`) build on these rather than beside them.
 *
 * The split is by PLACE, not by feature: a state rendered in a sidebar is a
 * compact row (it lives inside a ~16rem column, beside tree rows), and a state
 * rendered in a main pane is a centred block that owns the whole area. This
 * module is the sidebar half.
 *
 * What is deliberately NOT unified is the WORDS. "No agents in this drive yet",
 * "Loading conversations…" and "Failed to load agents" are different facts about
 * the world, and flattening them into one "Nothing to show" would destroy the
 * only information these states carry. Callers pass their own copy; this module
 * owns the shape, the spinner, and the tone.
 */

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** The one spinner on these surfaces. Everything that spins, spins like this. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 shrink-0 animate-spin text-muted-foreground', className)} aria-hidden="true" />;
}

/**
 * Muted for "this is a state of the world" (nothing selected, nothing here yet);
 * destructive for "this actually failed". The distinction is the whole point of
 * having a tone at all — an agent with no conversations yet is not an error, and
 * painting it red would say it was.
 */
export type Tone = 'muted' | 'destructive';

export const toneClass = (tone: Tone): string => (tone === 'destructive' ? 'text-destructive' : 'text-foreground');

export interface NoticeProps {
  /** Headline. Carries the fact — keep it specific to what actually happened. */
  title: string;
  /** Optional second line: what the reader can do about it, or why it happened. */
  description?: string;
  tone?: Tone;
  /** The one action that could change this state (a refetch, a retry). Omit when there isn't one. */
  actionLabel?: string;
  onAction?: () => void;
  /** Extra affordance below the action. */
  children?: ReactNode;
  testId?: string;
}

export function SidebarLoading({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
      <Spinner className="size-3" />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}

/**
 * Empty AND error, one component: they differ in their words and their tone, not
 * in their shape, and giving them separate layouts is exactly the drift this
 * module exists to remove. Both truncate with a `title` tooltip — a raw sandbox
 * error can be long, and a 16rem column must not stretch to fit it.
 */
export function SidebarNotice({
  title,
  description,
  tone = 'muted',
  actionLabel,
  onAction,
  children,
  testId,
}: NoticeProps) {
  return (
    <div className="flex flex-col items-start gap-1 px-2 py-1.5" data-testid={testId}>
      <p className={cn('min-w-0 max-w-full truncate text-xs font-medium', toneClass(tone))} title={title}>
        {title}
      </p>
      {description && (
        <p className="min-w-0 max-w-full text-xs text-muted-foreground" title={description}>
          {description}
        </p>
      )}
      {actionLabel && onAction && (
        // Wrapped rather than `onClick={onAction}`: React calls onClick with the
        // click's MouseEvent, and a caller whose `onAction` is (or wraps) an SWR
        // `mutate` would have that event handed to it as a first argument — SWR
        // reads that as replacement cache data, not "revalidate now". Calling
        // onAction() with no arguments here means every caller's zero-arg
        // contract holds regardless of what onAction closes over.
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onAction()}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
