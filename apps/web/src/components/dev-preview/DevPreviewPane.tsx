'use client';

/**
 * The preview pane: the holder's dev server, live, in an iframe beside the
 * agents console, with honest status chrome.
 *
 * THE FRAME. Its `src` is the APP-ORIGIN `/preview/open` route for the
 * reader (session or env). That route authenticates, runs the drive/session
 * gate, mints a single-use grant and 302s to the holder's dedicated preview
 * origin, whose auth endpoint installs a host-only partitioned cookie and
 * 302s to `/` — the frame does the rest, and root-relative URLs resolve
 * against the preview origin, so a real Vite/Next dev server just works. The
 * app's CSP `frame-src` admits `*.preview.<apex>` only when the feature is
 * configured, which is also the only time this component can render (the
 * capability gate below). `referrerPolicy="no-referrer"` keeps the app URL
 * out of the dev server's logs.
 *
 * SANDBOX ALLOW-LIST. The frame runs agent-authored (or npm-supply-chain)
 * code, so it gets exactly what a dev server needs and nothing that reaches
 * the PageSpace tab: `allow-scripts allow-same-origin allow-forms
 * allow-popups allow-modals`. `allow-same-origin` grants the frame ITS OWN
 * preview origin (not the parent's — it is cross-site by design), which is
 * what lets the partitioned cookie flow; without it the frame is an opaque
 * origin, sends no cookie and renders nothing. Withheld on purpose:
 * `allow-top-navigation` (and the `-by-user-activation` form — one in-frame
 * click must not be able to `top.location` the dashboard away),
 * `allow-downloads`, `allow-popups-to-escape-sandbox` (a popup the frame
 * opens stays sandboxed), `allow-pointer-lock`, `allow-orientation-lock`.
 *
 * RE-AUTH. The preview origin's cookie is short-lived; when it expires inside
 * the frame the origin renders a page that posts
 * `{ type: 'pagespace:dev-preview', event: 'reauth-required', holder }` to
 * this window (contract from the proxy task). The pane accepts it ONLY from
 * its own frame (`event.source === iframe.contentWindow`), only about ITS
 * holder, and at most once per {@link REAUTH_DEBOUNCE_MS} — every accepted
 * message costs a grant row on the server, so a page spamming it must not
 * be able to mint one per tick. Anything else is ignored — the frame's
 * content is untrusted code.
 *
 * OPEN IN NEW TAB is a plain link to the SAME `/preview/open` route with
 * `target="_blank"`: a top-level navigation, where the partitioned cookie does
 * not carry, so the route mints a fresh grant for that context (already
 * supported and tested server-side). `rel="noopener"` so the dev server's
 * tab holds no handle to PageSpace.
 *
 * STOP / RESUME write `stoppedByUserAt` through the store (via the actions
 * route, which reconciles once through the core). Offered only when the
 * server says they apply (`canStop` / `canResume`) AND that this viewer may
 * manage it (`canManage`) — all three read LIVE from the polled status, never
 * snapshotted at open; both refuse cleanly server-side regardless.
 *
 * REFRESH PROTECTION: while open, the pane registers with `useEditingStore`
 * (repo rule) — an auth refresh or an SWR revalidation must not tear down a
 * frame the user is working in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Play, RefreshCw, Share2, Square, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiRequestError, post } from '@/lib/auth/auth-fetch';
import { isDevPreviewReauthMessageFor } from '@pagespace/lib/services/sandbox/preview/dev-preview-contract';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import { devPreviewActionsPath, useDevPreviewStatus, type DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';
// Type-only, so nothing from that module reaches the browser bundle.
import type { DevPreviewUserAction } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { useDevPreviewPaneStore, type OpenDevPreview } from '@/stores/useDevPreviewPaneStore';
import { useEditingSession } from '@/stores/useEditingSession';
import { DETECTION_UNAVAILABLE_MESSAGE } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import { devPreviewApprovalAudience, devPreviewBadge } from './dev-preview-copy';

/** The open pane polls faster than the affordance: its chrome should notice a relay crash within a few seconds. */
const PANE_POLL_MS = 5_000;

/** A re-auth is a grant mint; one per this window is plenty for a cookie that lives ten minutes. */
export const REAUTH_DEBOUNCE_MS = 5_000;
/** Exactly what a dev server needs inside the frame, and nothing that reaches the PageSpace tab — see the docblock. */
export const DEV_PREVIEW_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';

/** Pure: the frame URL for a reload nonce — a changed query string forces a fresh navigation through the handshake. */
export function buildFrameSrc(openPath: string, nonce: number): string {
  return nonce === 0 ? openPath : `${openPath}${openPath.includes('?') ? '&' : '?'}r=${nonce}`;
}

/**
 * The pane beside the console. Renders only when a preview is open FOR THIS
 * DRIVE (`open.driveId === driveId`) and the capability is on; a preview
 * opened in another drive stays in the store, hidden and unpolled, until the
 * user returns. The per-open body is keyed by holder so every piece of
 * per-open state (the frame latch, the re-auth debounce) resets by identity
 * rather than by effect.
 */
export function DevPreviewPane({ driveId }: { driveId: string | null }) {
  const enabled = useDevPreviewCapability();
  const open = useDevPreviewPaneStore((state) => state.open);
  // Dark, nothing open, or open for another drive: the pane is not there.
  // `undefined` (capability still loading) renders nothing too — never a
  // frame that must vanish.
  if (enabled !== true || open === null || open.driveId !== driveId) return null;
  return <OpenDevPreviewPane key={`${open.holder.kind}:${open.holder.id}`} open={open} />;
}

function OpenDevPreviewPane({ open }: { open: OpenDevPreview }) {
  const reloadNonce = useDevPreviewPaneStore((state) => state.reloadNonce);
  const closePreview = useDevPreviewPaneStore((state) => state.closePreview);
  const reload = useDevPreviewPaneStore((state) => state.reload);
  // The open pane is one per viewer and has no disclosure to re-arm from, so
  // it never idle-pauses (`pauseWhenIdle: false`) — the affordance for the
  // same holder yields to it, so this is still one poll per holder.
  const { preview, error, mutate } = useDevPreviewStatus(open.statusPath, { pauseWhenIdle: false, intervalMs: PANE_POLL_MS });
  const [actioning, setActioning] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastReauthAt = useRef(0);
  // Once the frame has been shown for THIS open it stays mounted: a dev
  // server restarting (a transient `down`) must not unmount the frame —
  // that would throw away in-app state and re-mint a grant on remount. The
  // status line carries the honest state meanwhile. A latch adjusted during
  // render (React's "storing information from previous renders"), scoped to
  // this open by the parent's `key`.
  const [frameArmed, setFrameArmed] = useState(false);
  if (preview?.canOpen && !frameArmed) setFrameArmed(true);

  useEditingSession(`dev-preview-pane-${open.holder.kind}-${open.holder.id}`, true, 'form', { componentName: 'DevPreviewPane' });

  // The holder is gone or no longer ours (session ended, env deleted, access
  // revoked): the status route answers 404/403 and the pane closes itself
  // rather than framing a preview it can no longer vouch for. Any other
  // error keeps the last good answer and the poll retries.
  useEffect(() => {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) closePreview();
  }, [error, closePreview]);

  // The frame's re-auth signal. Origin-agnostic by necessity — the preview
  // host is a different site by design and this window does not know the
  // apex — but SOURCE-checked (our own frame's window, nothing else on the
  // page), SHAPE- and HOLDER-checked, and DEBOUNCED (each accepted message
  // mints a grant server-side). The only thing it can cause is a same-origin
  // reload of a route that re-authenticates anyway.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow ?? null;
      if (frameWindow === null || event.source !== frameWindow) return;
      if (!isDevPreviewReauthMessageFor(event.data, open.holder)) return;
      const now = Date.now();
      if (now - lastReauthAt.current < REAUTH_DEBOUNCE_MS) return;
      lastReauthAt.current = now;
      reload();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open.holder, reload]);

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
        await post(devPreviewActionsPath(open.statusPath), body);
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
    [open.statusPath, mutate],
  );

  const frameSrc = buildFrameSrc(open.openPath, reloadNonce);

  return (
    <aside
      className="flex h-full min-w-0 flex-1 flex-col border-l border-border bg-background"
      aria-label={`Dev server preview of ${open.title}`}
      data-testid="dev-preview-pane"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
        <span className="truncate font-medium text-foreground" title={open.title}>
          {open.title}
        </span>
        {preview && (
          <Badge variant={devPreviewBadge(preview.state).tone} className="shrink-0 text-[10px]" title={preview.state.message}>
            {devPreviewBadge(preview.state).label}
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
            // Re-point the frame AND re-read the status: a user hitting Reload
            // wants the whole pane to reflect now, not the last 5-second tick.
            onClick={() => {
              reload();
              mutate();
            }}
            title="Reload the preview"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Reload</span>
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground">
            <a href={open.openPath} target="_blank" rel="noopener noreferrer" title="Open the preview in a new tab">
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Open in new tab</span>
            </a>
          </Button>
          {preview?.canManage && preview.canStop && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
              disabled={actioning}
              onClick={() => void runAction({ kind: 'stop' })}
              // Nothing is being served while a decision is pending, so "Stop"
              // would name an act that has not happened. The same write does
              // the honest thing: put the offer away.
              title={preview.state.status === 'needs-approval' ? 'Dismiss this preview' : 'Switch the preview off'}
            >
              <Square className="size-3.5" aria-hidden="true" />
              {preview.state.status === 'needs-approval' ? 'Dismiss' : 'Stop'}
            </Button>
          )}
          {preview?.canManage && preview.canResume && (
            // One action, two honest names: a preview the user switched off is
            // RESUMED; a relay that is down (crashed, or a reconcile has not
            // caught up) is RESTARTED. Both ask the server for the same thing.
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
              disabled={actioning}
              onClick={() => void runAction({ kind: 'resume' })}
              title={preview.state.status === 'stopped' ? 'Switch the preview back on' : 'Restart the preview'}
            >
              <Play className="size-3.5" aria-hidden="true" />
              {preview.state.status === 'stopped' ? 'Resume' : 'Restart'}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground hover:text-foreground" onClick={closePreview} title="Close the preview pane">
            <X className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Close preview</span>
          </Button>
        </div>
      </div>

      <DevPreviewStatusLine preview={preview} frameMounted={frameArmed} />

      {frameArmed ? (
        <iframe
          key={frameSrc}
          ref={frameRef}
          src={frameSrc}
          title={`Dev server preview of ${open.title}`}
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox={DEV_PREVIEW_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          data-testid="dev-preview-frame"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground" data-testid="dev-preview-placeholder">
          <p className="max-w-sm">{preview ? preview.state.message : 'Loading preview status…'}</p>
          {preview?.canManage && preview.canApprove && preview.state.status === 'needs-approval' && (
            // The decision lives HERE and not on the affordance row: this is
            // the surface that can state who would be able to see it, and
            // sharing something should not be a one-click side effect of a
            // line in a list. The port comes off the NARROWED state, so the
            // button's label and the request it sends cannot name different
            // ports.
            <ApprovalControl port={preview.state.targetPort} spriteInstanceId={preview.spriteInstanceId} holder={preview.holder} disabled={actioning} onShare={runAction} />
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * The one explicit act that turns a detected port into a shared one, under the
 * sentence that says who would then be able to reach it. Split out so the port
 * is bound ONCE, where the state was narrowed.
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
      <Button size="sm" className="h-7 gap-1 px-3" disabled={disabled} onClick={() => onShare({ kind: 'approve', port, spriteInstanceId })} title={`Share port ${port}`}>
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
  // and the state message already says that. `'arming'` says nothing — it
  // resolves within a poll, and a flicker on every first render is noise.
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
