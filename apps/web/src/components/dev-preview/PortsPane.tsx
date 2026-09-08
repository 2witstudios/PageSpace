/**
 * The ports pane: what is actually listening in this session's sandbox, and a
 * preview of the port you pick.
 *
 * It exists because passive detection cannot see everything — Fly Sprites'
 * `ports/watch` never reports a Next.js dev server's bind — and because a
 * preview that fails should SAY so. Three rules shape it:
 *
 *  1. NEVER PROBE ON MOUNT. This pane is a persisted grid node: it comes back
 *     on every reload, on every device, for every viewer of the session. A
 *     probe is an exec, an exec wakes a paused sprite, and a wake is billed.
 *     So the list appears only behind an explicit Scan, and the status it
 *     shows before that is the cheap, already-cached one.
 *  2. PICKING IS CONSENT. Choosing a port from the list is the deliberate act
 *     the Share step was invented to require, so there is no second click —
 *     but the audience is stated right beside the choice, before it is made.
 *  3. THE SENTENCE COMES FROM THE SERVER. Every failure renders the route's
 *     own message inline. The client chooses loudness, never wording.
 *
 * One sandbox has exactly one preview, so several ports panes are several
 * views of the same state; the radio group marks which port is current and
 * a second pick reads as "Preview this instead" — which is what it does.
 */

'use client';

import { useCallback, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { post, ApiRequestError } from '@/lib/auth/auth-fetch';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import {
  devPreviewActionsPath,
  devPreviewPortsPath,
  sessionDevPreviewPath,
  useDevPreviewStatus,
} from '@/hooks/dev-preview/useDevPreviewStatus';
import { DEV_PREVIEW_FRAME_SANDBOX, buildFrameSrc } from './DevPreviewPane';
import { devPreviewApprovalAudience } from './dev-preview-copy';
import type { DevPreviewProbedPort } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

interface PortsListing {
  spriteInstanceId: string;
  ports: DevPreviewProbedPort[];
  currentPort: number | null;
}

type Scan =
  | { state: 'idle' }
  | { state: 'scanning' }
  | { state: 'listed'; listing: PortsListing }
  | { state: 'failed'; message: string };

/** The server's sentence, or a neutral one — never a stack trace, never silence. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.message.trim() !== '') return error.message;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}

export function PortsPane({ workspaceId }: { workspaceId: string }) {
  const enabled = useDevPreviewCapability();
  const statusPath = sessionDevPreviewPath(workspaceId);
  // The cheap, cached status — polled slowly, never an exec. This is all the
  // pane shows until Scan is pressed.
  const { preview, mutate } = useDevPreviewStatus(statusPath, { enabled: enabled === true, pauseWhenIdle: false });
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
        // A refused plan is a 200 with the refusal inside — `http-port-busy`
        // when something else holds 8080. Say so; the pick was recorded.
        if (answer.applied?.action === 'refuse') {
          setPickError(
            answer.applied.reason === 'http-port-busy'
              ? 'Port 8080 is held by another process in the sandbox, so the preview relay cannot start. Stop that process and pick again.'
              : 'The preview could not be started right now.',
          );
        }
        mutate();
        // Re-list so the radio marks the new current port.
        const listing = await post<PortsListing>(devPreviewPortsPath(statusPath), {});
        setScan({ state: 'listed', listing });
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

  // `openPath` is null until the holder has something to open; narrow at the
  // use site so the frame cannot be built from a null.
  // Listing ports is the first half of exposing one, so it takes the same
  // authority as sharing — and the route enforces that with a 403. Gate the
  // button on the SERVER's verdict rather than let a viewer who cannot manage
  // the preview press Scan and be refused every time; and hold it until the
  // status has loaded at all, because a pick is the consent gesture and the
  // audience it consents to is not on screen until then.
  const canManage = preview?.canManage === true;
  const openPath = preview?.canOpen === true && typeof preview.openPath === 'string' ? preview.openPath : null;
  const canOpen = openPath !== null;
  const frameSrc = openPath !== null ? buildFrameSrc(openPath, nonce) : null;
  const audience = preview ? devPreviewApprovalAudience(preview.holder) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ports-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={preview?.state.message} data-testid="ports-pane-status">
          {preview ? preview.state.message : 'Loading preview status…'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={() => void runScan()}
          disabled={scan.state === 'scanning' || !canManage}
          title={preview === undefined ? 'Loading preview status…' : canManage ? 'Ask the sandbox which ports are listening' : 'Only the session owner, or a drive owner or admin, can share a port from this sandbox'}
          data-testid="ports-scan"
        >
          {scan.state === 'scanning' ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <ScanSearch className="size-3.5" aria-hidden="true" />}
          Scan ports
        </Button>
        {canOpen && (
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
        <div className="shrink-0 border-b border-border px-3 py-2 text-xs" data-testid="ports-list">
          {scan.listing.ports.length === 0 ? (
            <p className="text-muted-foreground">Nothing is listening in the sandbox. Start your dev server, then Scan again.</p>
          ) : (
            <div role="radiogroup" aria-label="Listening ports" className="flex flex-col gap-1">
              {audience && <p className="pb-1 text-muted-foreground">{audience}</p>}
              {scan.listing.ports.map((entry) => {
                const disabled = entry.kind === 'ignored' || picking !== null || !canManage;
                const why = entry.kind === 'ignored'
                  ? entry.reason === 'non-http-service-port' ? 'Looks like a database or service port, not a web server'
                    : entry.reason === 'relay-own-listener' ? 'The preview relay itself'
                    : 'Cannot be previewed'
                  : entry.likelihood === 'known-dev-port' ? 'Looks like a dev server' : 'Unlisted port';
                return (
                  <button
                    key={entry.port}
                    type="button"
                    role="radio"
                    aria-checked={entry.current}
                    disabled={disabled}
                    onClick={() => void pick(entry.port, scan.listing.spriteInstanceId)}
                    className="flex items-center justify-between rounded px-2 py-1 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    title={why}
                    data-testid={`ports-pick-${entry.port}`}
                  >
                    <span className="font-mono">:{entry.port}{entry.pid !== null ? <span className="ml-2 text-muted-foreground">pid {entry.pid}</span> : null}</span>
                    <span className="text-muted-foreground">
                      {picking === entry.port ? 'Starting…' : entry.current ? 'Previewing' : entry.kind === 'ignored' ? why : 'Preview this' + (scan.listing.currentPort !== null ? ' instead' : '')}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
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
          <p className="max-w-sm">{scan.state === 'idle' ? 'Scan to see what is listening in the sandbox, then pick a port to preview it.' : preview?.state.message ?? ''}</p>
        </div>
      )}
    </div>
  );
}
