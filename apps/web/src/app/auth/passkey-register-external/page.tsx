'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { runPasskeyRegisterExternalCeremony } from '@/components/auth/runPasskeyRegisterExternalCeremony';
import {
  PasskeyRegisterExternalView,
  type PasskeyRegisterExternalStatus,
} from '@/components/auth/PasskeyRegisterExternalView';
import { parsePasskeyRegisterExternalParams } from '@/components/auth/passkeyExternal';

const HANDOFF_SETTLE_MS = 600;

function PasskeyRegisterExternalContent() {
  const [status, setStatus] = useState<PasskeyRegisterExternalStatus>({
    kind: 'running',
  });
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
          setStatus({ kind: 'error', message: result.error, code: result.code });
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
