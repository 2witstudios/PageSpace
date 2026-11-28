'use client';

import type { ReactNode } from 'react';

interface AuthStatusCardProps {
  /** Icon shown in the round badge above the title. */
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  /** Optional call to action rendered below the body copy. */
  action?: ReactNode;
}

/**
 * The v3 status card used by the signed-out status routes (email verified, account
 * deleted, desktop passkey handoff). Rendered only inside the Imago-enabled branch;
 * classic status pages keep their own markup.
 */
export function AuthStatusCard({ icon, title, children, action }: AuthStatusCardProps) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-[oklch(0.50_0.16_235/0.1)] text-[oklch(0.38_0.16_235)]">
        {icon}
      </span>
      <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-[oklch(0.15_0.01_220)]">
        {title}
      </h1>
      {children && (
        <div className="space-y-2 text-sm leading-[1.55] text-[oklch(0.48_0.015_220)]">{children}</div>
      )}
      {action && <div className="mt-2 flex w-full flex-col gap-2">{action}</div>}
    </div>
  );
}
