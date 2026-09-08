/**
 * The preview pane: the dev server the session is previewing, framed — and,
 * behind one header control, what is actually listening in the sandbox.
 *
 * A pane is bound to this surface by picking a port in the pane picker (the
 * select already happened there), so the body is the FRAME, first and by
 * default; until the relay is up it shows the server's status sentence.
 * The ports list stays reachable from the header because passive detection
 * cannot see everything — Fly Sprites' `ports/watch` never reports a Next.js
 * dev server's bind — and a preview that fails should SAY so. Three rules:
 *
 *  1. NEVER PROBE ON MOUNT. This pane is a persisted grid node: it comes back
 *     on every reload, on every device, for every viewer of the session. A
 *     probe is an exec, an exec wakes a paused sprite, and a wake is billed.
 *     So the list appears only behind an explicit click, and the status it
 *     shows before that is the cheap, already-cached one. (The PICKER probes
 *     when it opens — that is a user gesture, not a persisted node.)
 *  2. PICKING IS CONSENT. Choosing a port from the list is the deliberate act
 *     the Share step was invented to require, so there is no second click —
 *     but the audience is stated right beside the choice, before it is made.
 *  3. THE SENTENCE COMES FROM THE SERVER. Every failure renders the route's
 *     own message inline. The client chooses loudness, never wording.
 *
 * One sandbox has exactly one preview, so several of these panes are several
 * views of the same state; the list marks which port is current and a second
 * pick reads as "Preview this instead" — which is what it does.
 */

'use client';

import { useCallback, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/auth/auth-fetch';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import {
  devPreviewActionsPath,
  devPreviewPortsPath,
  sessionDevPreviewPath,
  useDevPreviewStatus,
} from '@/hooks/dev-preview/useDevPreviewStatus';
import { DEV_PREVIEW_FRAME_SANDBOX, PANE_POLL_MS, buildFrameSrc } from './DevPreviewPane';
import { CANNOT_MANAGE_PORTS, PICK_REFUSED, PICK_REFUSED_HTTP_PORT_BUSY, devPreviewApprovalAudience } from './dev-preview-copy';
import { PortsList, messageOf, type PortsListing } from './PortsList';

type Scan =
  | { state: 'idle' }
  | { state: 'scanning' }
  | { state: 'listed'; listing: PortsListing }
  | { state: 'failed'; message: string };

export function PortsPane({ workspaceId }: { workspaceId: string }) {
  const enabled = useDevPreviewCapability();
  const statusPath = sessionDevPreviewPath(workspaceId);
  // The cheap, cached status — polled at the open pane's cadence so the frame
  // appears as soon as the relay the pick started is up. Never an exec.
  const { preview, mutate } = useDevPreviewStatus(statusPath, { enabled: enabled === true, pauseWhenIdle: false, intervalMs: PANE_POLL_MS });
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  const [picking, setPicking] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const runScan = useCallback(async () => {
    setScan({ state: 'scanning' });
    setPickError(null);
    try {
      const listing = await post<PortsListing>(devPreviewPortsPath(statusPath), {});
      setScan({ state: 'listed', listing });
    } catch (error) {
      setScan({ state: 'failed', message: messageOf(error, 'The sandbox could not be asked which ports are listening.') });
    }
  }, [statusPath]);

  const toggleList = useCallback(() => {
    if (scan.state === 'idle') void runScan();
    else setScan({ state: 'idle' });
  }, [scan.state, runScan]);

  const pick = useCallback(
    async (port: number, spriteInstanceId: string) => {
      setPicking(port);
      setPickError(null);
      try {
        const answer = await post<{ ok: true; applied: { action: string; reason?: string } | null }>(
          devPreviewActionsPath(statusPath),
          // The instance is echoed from the listing so a pick made against a
          // sandbox that was rebuilt in between is refused, not applied.
          { action: 'select', port, spriteInstanceId },
        );
        mutate();
        // A refused plan is a 200 with the refusal inside — `http-port-busy`
        // when something else holds 8080. Say so, and keep the list open; the
        // pick was recorded.
        if (answer.applied?.action === 'refuse') {
          setPickError(answer.applied.reason === 'http-port-busy' ? PICK_REFUSED_HTTP_PORT_BUSY : PICK_REFUSED);
          return;
        }
        // The pick took: the pane is the preview again, the list folds away.
        setScan({ state: 'idle' });
      } catch (error) {
        setPickError(messageOf(error, 'Could not start the preview.'));
      } finally {
        setPicking(null);
      }
    },
    [statusPath, mutate],
  );

  if (enabled === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground" data-testid="ports-pane-dark">
        <AlertCircle className="h-8 w-8" />
        <p className="text-sm">Dev-server previews are not enabled on this deployment.</p>
      </div>
    );
  }

  // Listing ports is the first half of exposing one, so it takes the same
  // authority as sharing — and the route enforces that with a 403. Gate the
  // control on the SERVER's verdict rather than let a viewer who cannot
  // manage the preview open the list and be refused every time; and hold it
  // until the status has loaded at all, because a pick is the consent
  // gesture and the audience it consents to is not on screen until then.
  const canManage = preview?.canManage === true;
  // `openPath` is null until the holder has something to open; narrow at the
  // use site so the frame cannot be built from a null.
  const openPath = preview?.canOpen === true && typeof preview.openPath === 'string' ? preview.openPath : null;
  const frameSrc = openPath !== null ? buildFrameSrc(openPath, nonce) : null;
  const audience = preview ? devPreviewApprovalAudience(preview.holder) : null;
  const targetPort = preview && 'targetPort' in preview.state ? preview.state.targetPort : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ports-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
        {targetPort !== null && <span className="shrink-0 font-mono" data-testid="ports-pane-port">:{targetPort}</span>}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={preview?.state.message} data-testid="ports-pane-status">
          {preview ? preview.state.message : 'Loading preview status…'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={toggleList}
          disabled={scan.state === 'scanning' || !canManage}
          aria-pressed={scan.state !== 'idle'}
          title={preview === undefined ? 'Loading preview status…' : canManage ? 'Ask the sandbox which ports are listening' : CANNOT_MANAGE_PORTS}
          data-testid="ports-scan"
        >
          {scan.state === 'scanning' ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <ScanSearch className="size-3.5" aria-hidden="true" />}
          Ports
        </Button>
        {frameSrc !== null && (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setNonce((n) => n + 1)} title="Reload the preview" data-testid="ports-reload">
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      {scan.state === 'failed' && (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive" role="alert" data-testid="ports-scan-error">{scan.message}</p>
      )}
      {pickError && (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive" role="alert" data-testid="ports-pick-error">{pickError}</p>
      )}

      {scan.state === 'listed' && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <PortsList listing={scan.listing} audience={audience} canOpen={frameSrc !== null} picking={picking} disabled={!canManage} onPick={(port, instance) => void pick(port, instance)} />
        </div>
      )}

      {frameSrc ? (
        <iframe
          key={frameSrc}
          src={frameSrc}
          title="Dev server preview"
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox={DEV_PREVIEW_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          data-testid="ports-frame"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground" data-testid="ports-placeholder">
          {preview === undefined || preview.state.status === 'starting' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          <p className="max-w-sm">{preview ? preview.state.message : 'Loading preview status…'}</p>
          {preview && preview.state.status === 'none' && canManage && (
            <p className="max-w-sm">Open <span className="font-medium">Ports</span> above to choose what to preview.</p>
          )}
        </div>
      )}
    </div>
  );
}
