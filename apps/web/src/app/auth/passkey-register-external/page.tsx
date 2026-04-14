'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Info, Loader2, ShieldAlert } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import {
  runPasskeyRegisterExternalCeremony,
  type PasskeyRegisterExternalErrorCode,
} from '@/components/auth/runPasskeyRegisterExternalCeremony';
import { parsePasskeyRegisterExternalParams } from '@/components/auth/passkeyExternal';

export type PasskeyRegisterExternalStatus =
  | { kind: 'running' }
  | { kind: 'redirecting' }
  | { kind: 'error'; message: string; code?: PasskeyRegisterExternalErrorCode };

export function PasskeyRegisterExternalView({
  status,
}: {
  status: PasskeyRegisterExternalStatus;
}) {
  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        {status.kind === 'error' ? (
          <ErrorState status={status} />
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

function ErrorState({
  status,
}: {
  status: Extract<PasskeyRegisterExternalStatus, { kind: 'error' }>;
}) {
  if (status.code === 'ALREADY_REGISTERED') {
    return (
      <>
        <CheckCircle2 className="h-8 w-8 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">
            This device is already set up
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
          <p className="mt-4 text-xs text-muted-foreground">
            You can close this window and return to the desktop app.
          </p>
        </div>
      </>
    );
  }

  if (status.code === 'CANCELLED') {
    return (
      <>
        <Info className="h-8 w-8 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">
            Registration cancelled
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
          <p className="mt-4 text-xs text-muted-foreground">
            You can close this window and try again from the desktop app.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <ShieldAlert className="h-8 w-8 text-destructive" />
      <div>
        <p className="text-sm font-medium text-foreground">Registration failed</p>
        <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
        <p className="mt-4 text-xs text-muted-foreground">
          You can close this window and try again from the desktop app.
        </p>
      </div>
    </>
  );
}

function PasskeyRegisterExternalContent() {
  const [status, setStatus] = useState<PasskeyRegisterExternalStatus>({
    kind: 'running',
  });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

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
        if (result.ok) {
          setStatus({ kind: 'redirecting' });
          window.location.href = result.deepLink;
        } else {
          setStatus({ kind: 'error', message: result.error, code: result.code });
        }
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      });
  }, []);

  return <PasskeyRegisterExternalView status={status} />;
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
