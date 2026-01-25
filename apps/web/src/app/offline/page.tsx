import { Metadata } from 'next';
import { WifiOff, RefreshCw } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Offline',
  description: 'You are currently offline',
};

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <WifiOff className="h-8 w-8 text-muted-foreground" />
        </div>

        <h1 className="mb-2 text-2xl font-bold tracking-tight">You&apos;re offline</h1>

        <p className="mb-8 max-w-sm text-muted-foreground">
          Check your internet connection and try again. Some features may be available from cache.
        </p>

        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
