'use client';

import type { ReactNode } from 'react';

interface AuthFrameProps {
  children: ReactNode;
  /** Display name of the signed-in viewer; renders the "Signed in as" avatar on the spine. */
  signedInAs?: string;
}

/**
 * The v3 signed-out frame: a 72px blue spine carrying only the PageSpace spark tile
 * (plus an optional signed-in avatar), and a rounded sheet with a centred card column.
 * Pages render this through AuthLayout, never directly.
 */
export function AuthFrame({ children, signedInAs }: AuthFrameProps) {
  const initial = signedInAs?.trim().charAt(0).toUpperCase();
  return (
    <div
      data-auth-frame=""
      className="flex h-screen min-h-[640px] overflow-hidden bg-[oklch(0.35_0.08_235)] text-[oklch(0.15_0.01_220)]"
    >
      <div
        data-testid="auth-frame-spine"
        className="flex w-[72px] shrink-0 flex-col items-center py-[14px] shadow-[inset_-1px_0_0_oklch(0_0_0/0.15)]"
      >
        <span
          role="img"
          aria-label="PageSpace"
          className="grid size-9 place-items-center rounded-[11px] bg-[oklch(0.98_0.005_235)]"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="oklch(0.35 0.08 235)" aria-hidden="true">
            <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
          </svg>
        </span>
        <div className="flex-1" />
        {initial && (
          <span
            role="img"
            aria-label={`Signed in as ${signedInAs}`}
            title={`Signed in as ${signedInAs}`}
            className="grid size-8 place-items-center rounded-full bg-[oklch(1_0_0/0.15)] text-xs font-semibold text-[oklch(1_0_0)]"
          >
            {initial}
          </span>
        )}
      </div>
      <div
        data-testid="auth-frame-sheet"
        className="mt-2 flex min-w-0 flex-1 flex-col overflow-auto rounded-tl-[22px] bg-[oklch(0.995_0.002_240)] px-6 pb-12 pt-10 shadow-[-8px_0_32px_rgb(0_0_0/0.18)]"
      >
        <div className="flex-1" />
        <div data-testid="auth-frame-card" className="mx-auto w-full max-w-[400px]">
          {children}
        </div>
        <div className="flex-1" />
      </div>
    </div>
  );
}
