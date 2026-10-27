'use client';

/**
 * The detection affordance: one quiet line — "Dev server detected on :5173 —
 * Preview" — that appears in a session's or environment's chrome when the
 * detection pipeline has recorded a dev server there. It AUTO-OPENS NOTHING:
 * the pipeline records, this line offers, the user decides.
 *
 * Clicking OPENS THE PREVIEW PANE IN THE GRID (`openPorts`) — the same pane
 * picking a port in the pane picker binds, not a second surface of its own.
 * One sandbox has one preview, and the grid pane is the copy that persists,
 * that every viewer of the session sees, and that can sit beside the work it
 * belongs to; a per-viewer side panel showing the identical frame was two
 * containers for one thing. `openPorts` focuses the pane when the session
 * already has one, so this line is a shortcut into that surface and never a
 * way to make a second.
 *
 * `sessionId` is WHICH grid the pane lands in. An ENVIRONMENT's preview is
 * previewed from one of that environment's sessions (an env-bound session
 * reads the env's own holder — the status route resolves that), so the caller
 * passes the session it would open — which the click SELECTS before opening
 * the pane, since the console renders the selected session's grid and
 * nothing else. `null` means there is no grid to open into yet (an
 * environment with no sessions running), and the line then states what it
 * knows without offering an action it cannot perform.
 *
 * Rendered from the polled status read (`useDevPreviewStatus`), which the
 * server folds without ever probing the sprite — when the realtime tier has
 * no listener snapshot the line still shows the last-known state honestly
 * (the relay's own status carries it) and says nothing it cannot know.
 *
 * Gated on `useDevPreviewCapability()`: renders NOTHING — and FETCHES nothing,
 * the status key is disabled — on a deployment where the feature is dark
 * (the default everywhere). `undefined` (still loading) is treated as dark so
 * nothing flashes (the #2518 shape). Also nothing for the `none` state: a
 * session with no dev server shows no preview chrome at all.
 *
 * POLL DISCIPLINE (`useDevPreviewStatus`): polls only while `active` (the
 * caller's disclosure — an expanded env row; the console header is always
 * active while a session is selected) and stops after four idle answers until
 * the disclosure toggles.
 *
 * WHO MAY MANAGE is the server's answer (`preview.canManage`, read live by
 * the pane from the same status), never a prop: the client cannot know the
 * drive role, and the actions route enforces the same rule regardless.
 */

import { Globe } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import { useDevPreviewStatus } from '@/hooks/dev-preview/useDevPreviewStatus';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { devPreviewAffordanceText, devPreviewAffordanceVerb, shouldShowDevPreviewAffordance } from './dev-preview-copy';

/** The affordance polls slowly: a dev server coming up is a seconds-scale event, and every tick is a control-plane read. */
const AFFORDANCE_POLL_MS = 15_000;

/** Why the line offers no action: there is no grid to put the pane in yet. */
const NO_SESSION_TO_OPEN_IN = 'Start a session in this environment to preview it';

export function DevPreviewAffordance({
  statusPath,
  sessionId,
  active = true,
  pauseWhenIdle = true,
  className,
}: {
  /** The reader's status route — session or env. */
  statusPath: string;
  /** The session whose grid the preview pane opens in; `null` when there is none. */
  sessionId: string | null;
  /** The caller's disclosure: poll only while true; a toggle re-arms an idle-paused poll. */
  active?: boolean;
  /** Stop polling after four idle answers (per-row surfaces); a surface with no disclosure passes false. */
  pauseWhenIdle?: boolean;
  className?: string;
}) {
  const enabled = useDevPreviewCapability();
  const openPorts = useAgentWorkspaceStore((state) => state.openPorts);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const { preview } = useDevPreviewStatus(statusPath, { enabled: enabled === true, polling: active, pauseWhenIdle, intervalMs: AFFORDANCE_POLL_MS });

  if (enabled !== true || !shouldShowDevPreviewAffordance(preview)) return null;
  const text = devPreviewAffordanceText(preview);
  const verb = devPreviewAffordanceVerb(preview);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)} data-testid="dev-preview-affordance">
      <Globe className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate" title={preview.state.message}>
        {text}
      </span>
      <span aria-hidden="true">—</span>
      <button
        type="button"
        className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
        disabled={sessionId === null}
        title={sessionId === null ? NO_SESSION_TO_OPEN_IN : undefined}
        onClick={(event) => {
          // A row's own click targets (its context menu, its disclosure) must not also fire.
          event.stopPropagation();
          if (sessionId === null) return;
          // SELECT then open: the console renders the grid of the SELECTED
          // session, so opening a pane in another one (an env row while the
          // user is elsewhere) would change an off-screen grid and look like
          // the click did nothing. A no-op when it is already selected.
          selectSession(sessionId);
          openPorts(sessionId);
        }}
        data-testid="dev-preview-open"
      >
        {verb}
      </button>
    </div>
  );
}
