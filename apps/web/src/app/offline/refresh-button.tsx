'use client';

import { RefreshCw } from 'lucide-react';

export function RefreshButton() {
  return (
    <button
      onClick={() => window.location.reload()}
      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <RefreshCw className="h-4 w-4" />
      Try again
    </button>
  );
}
