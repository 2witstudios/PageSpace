import { Metadata } from 'next';
import { WifiOff } from 'lucide-react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { V3_BODY, V3_HEADING, V3_ICON_BOX_NEUTRAL } from '@/components/auth/auth-v3-styles';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { RefreshButton } from './refresh-button';

export const metadata: Metadata = {
  title: 'Offline',
  description: 'You are currently offline',
};

export default function OfflinePage() {
  if (isV3AuthEnabled()) {
    return (
      <AuthLayout classic="bare">
        <div className="flex flex-col">
          <span className={V3_ICON_BOX_NEUTRAL}>
            <WifiOff className="size-[22px]" aria-hidden="true" />
          </span>
          <h1 className={V3_HEADING}>You&apos;re offline</h1>
          <p className={V3_BODY}>Check your internet connection and try again. Some features may be available from cache.</p>
          <div className="mt-[26px]">
            <RefreshButton />
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout classic="bare">
      <div className="text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <WifiOff className="h-8 w-8 text-muted-foreground" />
        </div>

        <h1 className="mb-2 text-2xl font-bold tracking-tight">You&apos;re offline</h1>

        <p className="mb-8 max-w-sm text-muted-foreground">
          Check your internet connection and try again. Some features may be available from cache.
        </p>

        <RefreshButton />
      </div>
    </AuthLayout>
  );
}
