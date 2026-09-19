'use client';

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * FloatingInputRegion — THE sanctioned mount point for `FloatingInputLayer`.
 *
 * The layer's centered position is container-relative: it animates to
 * `-50cqh`, and container-query height units resolve against the nearest
 * ancestor with `container-type: size` — THIS element. Without it, `cqh`
 * falls back to the viewport and the layer silently centers against the
 * WINDOW while sitting inside a pane — wrong, and invisible in code review.
 *
 * So the contract lives here, baked into the class list where a caller would
 * have to actively strip it out rather than passively forget to add it.
 * Mount `FloatingInputLayer` nowhere except inside this region; size the
 * region with `className` (it must have a definite height — `h-full` or a
 * `flex-1 min-h-0` child of a column).
 */
export function FloatingInputRegion({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('relative overflow-hidden [container-type:size]', className)}>
      {children}
    </div>
  );
}

export default FloatingInputRegion;
