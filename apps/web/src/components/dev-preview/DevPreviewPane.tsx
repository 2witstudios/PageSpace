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
 * server says they apply (`canStop` / `canResume`) AND the reader may manage
 * the preview; both refuse cleanly server-side regardless.
 *
 * REFRESH PROTECTION: while open, the pane registers with `useEditingStore`
 * (repo rule) — an auth refresh or an SWR revalidation must not tear down a
 * frame the user is working in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Play, RefreshCw, Square, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/auth/auth-fetch';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import { useDevPreviewStatus, type DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';
import { useDevPreviewPaneStore } from '@/stores/useDevPreviewPaneStore';
import { useEditingSession } from '@/stores/useEditingSession';
import { devPreviewBadge } from './dev-preview-copy';

/** The open pane polls faster than the affordance: its chrome should notice a relay crash within a few seconds. */
const PANE_POLL_MS = 5_000;

/** The message the preview origin posts when its cookie has expired inside the frame. */
export const DEV_PREVIEW_REAUTH_MESSAGE_TYPE = 'pagespace:dev-preview';
/** A re-auth is a grant mint; one per this window is plenty for a cookie that lives ten minutes. */
export const REAUTH_DEBOUNCE_MS = 5_000;
/** Exactly what a dev server needs inside the frame, and nothing that reaches the PageSpace tab — see the docblock. */
export const DEV_PREVIEW_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';

interface ReauthMessage {
  type: typeof DEV_PREVIEW_REAUTH_MESSAGE_TYPE;
  event: 'reauth-required';
  holder: { kind: 'workspace' | 'env'; id: string };
}

/** Pure: is this a re-auth request about `holder`? Anything else (other shapes, other holders) is ignored. */
export function isReauthMessageFor(data: unknown, holder: { kind: string; id: string }): data is ReauthMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Partial<ReauthMessage>;
  return (
    message.type === DEV_PREVIEW_REAUTH_MESSAGE_TYPE &&
    message.event === 'reauth-required' &&
    typeof message.holder === 'object' &&
    message.holder !== null &&
    message.holder.kind === holder.kind &&
    message.holder.id === holder.id
  );
}

/** Pure: the frame URL for a reload nonce — a changed query string forces a fresh navigation through the handshake. */
export function buildFrameSrc(openPath: string, nonce: number): string {
  return nonce === 0 ? openPath : `${openPath}${openPath.includes('?') ? '&' : '?'}r=${nonce}`;
}

export function DevPreviewPane() {
  const enabled = useDevPreviewCapability();
  const open = useDevPreviewPaneStore((state) => state.open);
  const reloadNonce = useDevPreviewPaneStore((state) => state.reloadNonce);
  const closePreview = useDevPreviewPaneStore((state) => state.closePreview);
  const reload = useDevPreviewPaneStore((state) => state.reload);
  const { preview, mutate } = useDevPreviewStatus(open?.statusPath ?? null, { enabled: enabled === true, intervalMs: PANE_POLL_MS });
  const [actioning, setActioning] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastReauthAt = useRef(0);

  useEditingSession(`dev-preview-pane-${open?.holder.kind ?? 'none'}-${open?.holder.id ?? 'none'}`, open !== null, 'form', {
    componentName: 'DevPreviewPane',
  });

  // The frame's re-auth signal. Origin-agnostic by necessity — the preview
  // host is a different site by design and this window does not know the
  // apex — but SOURCE-checked (our own frame's window, nothing else on the
  // page), SHAPE- and HOLDER-checked, and DEBOUNCED (each accepted message
  // mints a grant server-side). The only thing it can cause is a same-origin
  // reload of a route that re-authenticates anyway.
  useEffect(() => {
    if (open === null) return;
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow ?? null;
      if (frameWindow === null || event.source !== frameWindow) return;
      if (!isReauthMessageFor(event.data, open.holder)) return;
      const now = Date.now();
      if (now - lastReauthAt.current < REAUTH_DEBOUNCE_MS) return;
      lastReauthAt.current = now;
      reload();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, reload]);

  const runAction = useCallback(
    async (action: 'stop' | 'resume') => {
      if (open === null) return;
      setActioning(true);
      try {
        await post(open.actionsPath, { action });
      } catch (error) {
        toast.error(action === 'stop' ? 'Could not switch the preview off' : 'Could not switch the preview on', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      } finally {
        setActioning(false);
        mutate();
      }
    },
    [open, mutate],
  );

  // Dark, or nothing open: the pane is not there. `undefined` (capability
  // still loading) renders nothing too — never a frame that must vanish.
  if (enabled !== true || open === null) return null;

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
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" onClick={reload} title="Reload the preview">
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Reload</span>
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground">
            <a href={open.openPath} target="_blank" rel="noopener noreferrer" title="Open the preview in a new tab">
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Open in new tab</span>
            </a>
          </Button>
          {open.canManage && preview?.canStop && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" disabled={actioning} onClick={() => void runAction('stop')} title="Switch the preview off">
              <Square className="size-3.5" aria-hidden="true" />
              Stop
            </Button>
          )}
          {open.canManage && preview?.canResume && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" disabled={actioning} onClick={() => void runAction('resume')} title="Switch the preview back on">
              <Play className="size-3.5" aria-hidden="true" />
              Resume
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground hover:text-foreground" onClick={closePreview} title="Close the preview pane">
            <X className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Close preview</span>
          </Button>
        </div>
      </div>

      <DevPreviewStatusLine preview={preview} />

      {preview?.canOpen ? (
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
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground" data-testid="dev-preview-placeholder">
          {preview ? preview.state.message : 'Loading preview status…'}
        </div>
      )}
    </aside>
  );
}

/**
 * The honest line under the header: the server's own message while the frame
 * is up but the state is not plainly live (a relay still starting), plus the
 * 8080 slot explanation whenever the slot is known to be held by something
 * that is not our relay. When the frame is NOT openable the placeholder below
 * carries the state message instead, so it is never said twice; a live relay
 * with a relay-held slot says nothing — the badge already does.
 */
function DevPreviewStatusLine({ preview }: { preview: DevPreviewStatusDTO | undefined }) {
  if (!preview) return null;
  const showState = preview.canOpen && preview.state.status !== 'live';
  const showSlot = preview.slot.known && preview.slot.holder === 'user-process';
  if (!showState && !showSlot) return null;
  const tone = preview.state.status === 'blocked' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className={`shrink-0 space-y-0.5 border-b border-border px-2 py-1 text-xs ${tone}`} data-testid="dev-preview-status-line">
      {showState && <div>{preview.state.message}</div>}
      {showSlot && preview.slot.known && <div>{preview.slot.message}</div>}
    </div>
  );
}
