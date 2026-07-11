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
 * What is deliberately NOT unified is the WORDS. "This branch hasn't been checked
 * out yet", "No uncommitted changes on main" and "Connecting…" are three different
 * facts about the world, and flattening them into one "Nothing to show" would
 * destroy the only information these states carry. Callers pass their own copy;
 * this module owns the shape, the spinner, and the tone.
 */

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** The one spinner on this surface. Everything that spins, spins like this. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 shrink-0 animate-spin text-muted-foreground', className)} aria-hidden="true" />;
}

/**
 * Muted for "this is a state of the world" (no changes, not cloned yet, nothing
 * selected); destructive for "this actually failed". The distinction is the whole
 * point of having a tone at all — a checkout that was never made is not an error,
 * and painting it red would say it was.
 */
type Tone = 'muted' | 'destructive';

const toneClass = (tone: Tone): string => (tone === 'destructive' ? 'text-destructive' : 'text-foreground');

interface NoticeProps {
  /** Headline. Carries the fact — keep it specific to what actually happened. */
  title: string;
  /** Optional second line: what the reader can do about it, or why it happened. */
  description?: string;
  tone?: Tone;
  /** The one action that could change this state (a refetch, a retry). Omit when there isn't one. */
  actionLabel?: string;
  onAction?: () => void;
  /** Extra affordance below the action (e.g. the Add-project dialog trigger). */
  children?: ReactNode;
  testId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Inner-sidebar states — compact rows, sized to sit among tree rows.         */
/* -------------------------------------------------------------------------- */

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
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}

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
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
