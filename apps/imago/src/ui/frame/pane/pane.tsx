'use client';

import { useState, type ReactNode, type TransitionEvent } from 'react';
import { renderPane } from './pane.render';

export type PaneProps = {
  readonly open: boolean;
  /** This stage's width token (shell-class.ts). */
  readonly width: string;
  readonly slot?: string;
  readonly children: ReactNode;
};

type Held = { readonly content: ReactNode };

type Last = { readonly open: boolean; readonly children: ReactNode };

/**
 * One column of the shell. It is always mounted, so moving between stages
 * never remounts what it holds; it only changes width. A closing pane keeps
 * showing what it last held open until its own width transition ends, so the
 * content slides out with it instead of vanishing first; after that it shows
 * its current children (nothing, for a list; the route, for the object slot,
 * which Next's router must keep mounted). Reduced motion cuts the duration
 * to 0.01ms (globals.css), not 0s, so transitionend still fires.
 */
export function Pane({ open, width, slot, children }: PaneProps) {
  const [held, setHeld] = useState<Held | null>(null);
  const [last, setLast] = useState<Last>({ open, children });
  // Adjusted while rendering, not in an effect: the held content must
  // already be in place on the render that closes the pane.
  if (last.open !== open || last.children !== children) {
    if (last.open && !open) setHeld({ content: last.children });
    if (open && held !== null) setHeld(null);
    setLast({ open, children });
  }
  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    // Only the pane's own width: a transition inside it bubbles here too.
    if (!open && event.target === event.currentTarget) setHeld(null);
  };
  const content = !open && held !== null ? held.content : children;
  return renderPane({ open, width, slot, content, onTransitionEnd });
}
