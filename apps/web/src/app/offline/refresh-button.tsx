'use client';

import { RefreshCw } from 'lucide-react';
import { V3_SECONDARY_BUTTON } from '@/components/auth/auth-v3-styles';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';

export function RefreshButton() {
  const v3 = isV3AuthEnabled();
  return (
    <button
      onClick={() => window.location.reload()}
      className={
        v3
          ? V3_SECONDARY_BUTTON
          : 'inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
      }
    >
      <RefreshCw className="h-4 w-4" />
      Try again
    </button>
  );
}
