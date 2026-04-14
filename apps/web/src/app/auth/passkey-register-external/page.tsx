'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { HandoffCompleteCard } from '@/components/auth/HandoffCompleteCard';
import { runPasskeyRegisterExternalCeremony } from '@/components/auth/runPasskeyRegisterExternalCeremony';
import { parsePasskeyRegisterExternalParams } from '@/components/auth/passkeyExternal';

type Status =
  | { kind: 'running' }
  | { kind: 'redirecting' }
  | { kind: 'complete' }
  | { kind: 'error'; message: string };

const HANDOFF_SETTLE_MS = 600;

function PasskeyRegisterExternalContent() {
  const [status, setStatus] = useState<Status>({ kind: 'running' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let unmounted = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const params = parsePasskeyRegisterExternalParams(
      window.location.search,
      window.location.hash,
    );
    if (!params) {
      setStatus({
        kind: 'error',
        message: 'Missing handoff token or device info in the handoff URL.',
      });
      return;
    }

    // Drop the fragment from the visible URL so the capability token is not
    // left sitting in the browser address bar after consumption.
    if (window.location.hash) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }

    runPasskeyRegisterExternalCeremony({
      handoffToken: params.handoffToken,
      deviceName: params.deviceName,
    })
      .then((result) => {
        if (unmounted) return;
        if (result.ok) {
          setStatus({ kind: 'redirecting' });
          window.location.href = result.deepLink;
          settleTimer = setTimeout(() => {
            if (unmounted) return;
            setStatus({ kind: 'complete' });
            try {
              window.close();
            } catch {
              // Best-effort: many browsers refuse window.close() for tabs
              // not opened via window.open(). The terminal UI is the fallback.
            }
          }, HANDOFF_SETTLE_MS);
        } else {
          setStatus({ kind: 'error', message: result.error });
        }
      })
      .catch((err: unknown) => {
        if (unmounted) return;
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      });

    return () => {
      unmounted = true;
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, []);

  if (status.kind === 'complete') {
    return (
      <AuthShell>
        <HandoffCompleteCard variant="passkey-added" />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        {status.kind === 'error' ? (
          <>
            <ShieldAlert className="h-8 w-8 text-destructive" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Could not add passkey
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
              <p className="mt-4 text-xs text-muted-foreground">
                You can close this window and try again from the desktop app.
              </p>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {status.kind === 'redirecting'
                  ? 'Returning to the desktop app…'
                  : 'Adding your passkey…'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Use Touch ID, Windows Hello, or your security key when prompted.
              </p>
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function PasskeyRegisterExternalPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Preparing passkey prompt…</p>
          </div>
        </AuthShell>
      }
    >
      <PasskeyRegisterExternalContent />
    </Suspense>
  );
}
