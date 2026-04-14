'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { runPasskeyRegisterExternalCeremony } from '@/components/auth/runPasskeyRegisterExternalCeremony';
import { parsePasskeyRegisterExternalParams } from '@/components/auth/passkeyExternal';

type Status =
  | { kind: 'running' }
  | { kind: 'redirecting' }
  | { kind: 'error'; message: string };

function PasskeyRegisterExternalContent() {
  const [status, setStatus] = useState<Status>({ kind: 'running' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = parsePasskeyRegisterExternalParams(window.location.search);
    if (!params) {
      setStatus({
        kind: 'error',
        message: 'Missing handoff token or device info in the handoff URL.',
      });
      return;
    }

    void runPasskeyRegisterExternalCeremony({
      handoffToken: params.handoffToken,
      deviceName: params.deviceName,
    }).then((result) => {
      if (result.ok) {
        setStatus({ kind: 'redirecting' });
        window.location.href = result.deepLink;
      } else {
        setStatus({ kind: 'error', message: result.error });
      }
    });
  }, []);

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
