/**
 * THE preview surface: the dev server this session's sandbox is serving,
 * framed, with the honest chrome that governs it — and, behind one header
 * control, the list of what is actually listening.
 *
 * There is exactly one of these. A pane is bound to it by picking a port in
 * the pane picker (the select already happened there), so the body is the
 * FRAME, first and by default; until the relay is up it shows the server's
 * status sentence. Detection's affordance ("Dev server detected on :3000 —
 * Preview") opens THIS pane rather than a second surface of its own: one
 * sandbox has one preview, and a persisted grid pane is the thing that
 * survives a reload, is shared with everyone who can open the session, and
 * can be placed next to the work it belongs to.
 *
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
 *     A port DETECTED rather than picked still needs that act: `needs-approval`
 *     renders the Share control under the same sentence.
 *  3. THE SENTENCE COMES FROM THE SERVER. Every failure renders the route's
 *     own message inline. The client chooses loudness, never wording.
 *
 * Several of these panes are several views of the same state; the list marks
 * which port is current and a second pick reads as "Preview this instead" —
 * which is what it does.
 *
 * The frame's own contract — src, sandbox flags, re-auth, new tab — is
 * `./preview-frame`. REFRESH PROTECTION: the pane registers with
 * `useEditingStore` (repo rule) so an auth refresh or an SWR revalidation
 * cannot tear down a frame the user is working in.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2, Play, RefreshCw, ScanSearch, Share2, Square } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/auth/auth-fetch';
import { isDevPreviewReauthMessageFor } from '@pagespace/lib/services/sandbox/preview/dev-preview-contract';
import { DETECTION_UNAVAILABLE_MESSAGE } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import {
  devPreviewActionsPath,
  devPreviewPortsPath,
  sessionDevPreviewPath,
  useDevPreviewStatus,
  type DevPreviewStatusDTO,
} from '@/hooks/dev-preview/useDevPreviewStatus';
import { useEditingSession } from '@/stores/useEditingSession';
// Type-only, so nothing from that module reaches the browser bundle.
import type { DevPreviewUserAction } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { DEV_PREVIEW_FRAME_SANDBOX, PANE_POLL_MS, REAUTH_DEBOUNCE_MS, buildFrameSrc } from './preview-frame';
import { CANNOT_MANAGE_PORTS, PICK_REFUSED, PICK_REFUSED_HTTP_PORT_BUSY, devPreviewApprovalAudience, devPreviewBadge } from './dev-preview-copy';
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
  // appears as soon as the relay a pick started is up. Never an exec.
  const { preview, error, mutate } = useDevPreviewStatus(statusPath, { enabled: enabled === true, pauseWhenIdle: false, intervalMs: PANE_POLL_MS });
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  const [picking, setPicking] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [actioning, setActioning] = useState(false);
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastReauthAt = useRef(0);
  // Once the frame has been shown it stays mounted: a dev server restarting (a
  // transient `down`) must not unmount it — that would throw away in-app state
  // and re-mint a grant on remount. The status line carries the honest state
  // meanwhile. A latch adjusted during render (React's "storing information
  // from previous renders").
  const [frameArmed, setFrameArmed] = useState(false);
  if (preview?.canOpen && !frameArmed) setFrameArmed(true);

  useEditingSession(`dev-preview-pane-${workspaceId}`, true, 'form', { componentName: 'PortsPane' });

  const holderKind = preview?.holder.kind;
  const holderId = preview?.holder.id;
  // The frame's re-auth signal. Origin-agnostic by necessity — the preview
  // host is a different site by design and this window does not know the apex
  // — but SOURCE-checked (our own frame's window, nothing else on the page),
  // SHAPE- and HOLDER-checked, and DEBOUNCED (each accepted message mints a
  // grant server-side). The only thing it can cause is a same-origin reload of
  // a route that re-authenticates anyway. Without this the frame sits on the
  // "session expired" page for the rest of the cookie's life.
  useEffect(() => {
    if (holderKind === undefined || holderId === undefined) return;
    const holder = { kind: holderKind, id: holderId };
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow ?? null;
      if (frameWindow === null || event.source !== frameWindow) return;
      if (!isDevPreviewReauthMessageFor(event.data, holder)) return;
      const now = Date.now();
      if (now - lastReauthAt.current < REAUTH_DEBOUNCE_MS) return;
      lastReauthAt.current = now;
      setNonce((n) => n + 1);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [holderKind, holderId]);

  const runScan = useCallback(async () => {
    setScan({ state: 'scanning' });
    setPickError(null);
    try {
      const listing = await post<PortsListing>(devPreviewPortsPath(statusPath), {});
      setScan({ state: 'listed', listing });
    } catch (scanError) {
      setScan({ state: 'failed', message: messageOf(scanError, 'The sandbox could not be asked which ports are listening.') });
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
      } catch (error_) {
        setPickError(messageOf(error_, 'Could not start the preview.'));
      } finally {
        setPicking(null);
      }
    },
    [statusPath, mutate],
  );

  const runAction = useCallback(
    // The SERVER's own action type, not a client-side lookalike: the route's
    // body parser produces exactly this shape, so one union spans the wire.
    async (action: DevPreviewUserAction) => {
      setActioning(true);
      // The approve body ECHOES the port the user was just shown; the server
      // refuses it with a 409 if the dev server has moved since, rather than
      // sharing whatever is running now.
      const body = action.kind === 'approve'
        ? { action: 'approve', port: action.port, spriteInstanceId: action.spriteInstanceId }
        : { action: action.kind };
      try {
        // A DEFERRED action succeeded — the stop was cleared, the consent
        // recorded — but the relay start is still waiting on something, which
        // can take a poll or two. Saying so beats silence.
        const answer = await post<{ deferred?: string }>(devPreviewActionsPath(statusPath), body);
        if (answer?.deferred !== undefined) {
          toast.info('The preview will start shortly', {
            description: answer.deferred === 'awaiting-reconcile'
              ? 'Another change to this preview is being applied first.'
              : 'Waiting for the sandbox to report which ports are in use.',
          });
        }
      } catch (actionError) {
        const failure =
          action.kind === 'stop' ? 'Could not switch the preview off'
          : action.kind === 'resume' ? 'Could not switch the preview on'
          : 'Could not share the preview';
        toast.error(failure, { description: actionError instanceof Error ? actionError.message : 'Please try again.' });
      } finally {
        setActioning(false);
        mutate();
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
  const openPath = typeof preview?.openPath === 'string' ? preview.openPath : null;
  const frameSrc = frameArmed && openPath !== null ? buildFrameSrc(openPath, nonce) : null;
  const audience = preview ? devPreviewApprovalAudience(preview.holder) : null;
  const badge = preview ? devPreviewBadge(preview.state) : null;
  const approvable = preview?.canManage === true && preview.canApprove && preview.state.status === 'needs-approval'
    ? { port: preview.state.targetPort, spriteInstanceId: preview.spriteInstanceId, holder: preview.holder }
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ports-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
        {/*
          The badge names the state AND the port. The MESSAGE is said once,
          below: by the status line while the frame is mounted, by the
          placeholder while it is not — see `DevPreviewStatusLine`.
        */}
        {badge && (
          <Badge variant={badge.tone} className="shrink-0 text-[10px]" title={preview?.state.message} data-testid="ports-pane-badge">
            {badge.label}
          </Badge>
        )}
        <span className="min-w-0 flex-1" />
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
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            // Re-point the frame AND re-read the status: a user hitting Reload
            // wants the whole pane to reflect now, not the last 5-second tick.
            onClick={() => {
              setNonce((n) => n + 1);
              mutate();
            }}
            title="Reload the preview"
            data-testid="ports-reload"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Reload</span>
          </Button>
        )}
        {openPath !== null && (
          <Button asChild variant="ghost" size="sm" className="h-7 px-2">
            <a href={openPath} target="_blank" rel="noopener noreferrer" title="Open the preview in a new tab" data-testid="ports-new-tab">
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Open in new tab</span>
            </a>
          </Button>
        )}
        {canManage && preview?.canStop && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={actioning}
            onClick={() => void runAction({ kind: 'stop' })}
            // Nothing is being served while a decision is pending, so "Stop"
            // would name an act that has not happened. The same write does
            // the honest thing: put the offer away.
            title={preview.state.status === 'needs-approval' ? 'Dismiss this preview' : 'Switch the preview off'}
            data-testid="ports-stop"
          >
            <Square className="size-3.5" aria-hidden="true" />
            {preview.state.status === 'needs-approval' ? 'Dismiss' : 'Stop'}
          </Button>
        )}
        {canManage && preview?.canResume && (
          // One action, two honest names: a preview the user switched off is
          // RESUMED; a relay that is down (crashed, or a reconcile has not
          // caught up) is RESTARTED. Both ask the server for the same thing.
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={actioning}
            onClick={() => void runAction({ kind: 'resume' })}
            title={preview.state.status === 'stopped' ? 'Switch the preview back on' : 'Restart the preview'}
            data-testid="ports-resume"
          >
            <Play className="size-3.5" aria-hidden="true" />
            {preview.state.status === 'stopped' ? 'Resume' : 'Restart'}
          </Button>
        )}
      </div>

      <DevPreviewStatusLine preview={preview} frameMounted={frameSrc !== null} />

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

      {/*
        The decision has to stay reachable AFTER the frame has been armed.
        `frameArmed` latches on the first openable answer and never clears, so
        putting the only Share control in its `else` branch meant a preview
        that went live and then moved to a NEW unlisted port — approval is
        recorded per port, so the new one is unapproved — re-entered
        `needs-approval` with no way to say yes.
      */}
      {frameSrc !== null && approvable && (
        <div className="flex shrink-0 flex-col items-center gap-2 border-b border-border px-3 py-3 text-center text-xs text-muted-foreground">
          <p className="max-w-sm">{preview?.state.message}</p>
          <ApprovalControl {...approvable} disabled={actioning} onShare={runAction} />
        </div>
      )}

      {frameSrc !== null ? (
        <iframe
          key={frameSrc}
          ref={frameRef}
          src={frameSrc}
          title="Dev server preview"
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox={DEV_PREVIEW_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          data-testid="ports-frame"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground" data-testid="ports-placeholder">
          {preview === undefined && error === undefined ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          <p className="max-w-sm">
            {preview ? preview.state.message : error instanceof Error ? error.message : 'Loading preview status…'}
          </p>
          {approvable ? (
            // The decision lives HERE and not on the affordance row: this is
            // the surface that can state who would be able to see it, and
            // sharing something should not be a one-click side effect of a
            // line in a list. The port comes off the NARROWED state, so the
            // button's label and the request it sends cannot name different
            // ports.
            <ApprovalControl {...approvable} disabled={actioning} onShare={runAction} />
          ) : preview?.state.status === 'none' && canManage ? (
            <p className="max-w-sm">Open <span className="font-medium">Ports</span> above to choose what to preview.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The one explicit act that turns a DETECTED port into a shared one, under the
 * sentence that says who would then be able to reach it. (A port PICKED from
 * the list needs no second click — the pick is the consent.) Split out so the
 * port is bound ONCE, where the state was narrowed.
 */
function ApprovalControl({
  port,
  spriteInstanceId,
  holder,
  disabled,
  onShare,
}: {
  port: number;
  /** Null only when nothing is attached, in which case there is nothing to share. */
  spriteInstanceId: string | null;
  holder: DevPreviewStatusDTO['holder'];
  disabled: boolean;
  onShare: (action: DevPreviewUserAction) => void;
}) {
  if (spriteInstanceId === null) return null;
  return (
    <>
      <p className="max-w-sm">{devPreviewApprovalAudience(holder)}</p>
      <Button size="sm" className="h-7 gap-1 px-3" disabled={disabled} onClick={() => onShare({ kind: 'approve', port, spriteInstanceId })} title={`Share port ${port}`} data-testid="ports-share">
        <Share2 className="size-3.5" aria-hidden="true" />
        Share :{port}
      </Button>
    </>
  );
}

/**
 * The honest line under the header: the server's own message whenever the
 * frame is mounted but the state is not plainly live (a relay still
 * starting, a dev server mid-restart, a preview switched off while the frame
 * keeps its last render), plus the 8080 slot explanation whenever the slot
 * is known to be held by something that is not our relay. When the frame is
 * NOT mounted the placeholder below carries the state message instead, so it
 * is never said twice; a live relay with a relay-held slot says nothing — the
 * badge already does.
 */
function DevPreviewStatusLine({ preview, frameMounted }: { preview: DevPreviewStatusDTO | undefined; frameMounted: boolean }) {
  if (!preview) return null;
  const showState = frameMounted && preview.state.status !== 'live';
  // The slot line states WHO holds 8080 (a fact, with the pid); the advice
  // for a held slot is the core's, carried by the `blocked` state's message.
  // A direct row's own server on 8080 is not worth a line.
  const showSlot = preview.slot.known && preview.slot.holder === 'user-process' && !(preview.state.status === 'live' && preview.state.via === 'direct');
  // Nothing is watching this sandbox's ports, so what is shown may lag. Said
  // only for a LIVE sandbox: with none attached there is nothing to detect,
  // and the state message already says that.
  const showDetection = preview.detection === 'unavailable' && preview.sandbox === 'attached';
  if (!showState && !showSlot && !showDetection) return null;
  const tone = preview.state.status === 'blocked' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className={`shrink-0 space-y-0.5 border-b border-border px-2 py-1 text-xs ${tone}`} data-testid="dev-preview-status-line">
      {showState && <div>{preview.state.message}</div>}
      {showSlot && preview.slot.known && <div>{preview.slot.message}</div>}
      {showDetection && <div>{DETECTION_UNAVAILABLE_MESSAGE}</div>}
    </div>
  );
}
