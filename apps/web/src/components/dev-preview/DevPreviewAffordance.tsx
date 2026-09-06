'use client';

/**
 * The detection affordance: one quiet line — "Dev server detected on :5173 —
 * Preview" — that appears in a session's or environment's chrome when the
 * detection pipeline has recorded a dev server there, and opens the preview
 * pane on click. It AUTO-OPENS NOTHING: the pipeline records, this line
 * offers, the user decides.
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
 * active while a session is selected), stops after four idle answers until
 * the disclosure toggles, and runs NO timer while the pane is open on this
 * same holder — the pane owns the poll and this line reads the shared cache.
 *
 * WHO MAY MANAGE is the server's answer (`preview.canManage`, read live by
 * the pane from the same status), never a prop: the client cannot know the
 * drive role, and the actions route enforces the same rule regardless.
 */

import { Globe } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useDevPreviewCapability } from '@/hooks/dev-preview/useDevPreviewCapability';
import { useDevPreviewStatus } from '@/hooks/dev-preview/useDevPreviewStatus';
import { useDevPreviewPaneStore } from '@/stores/useDevPreviewPaneStore';
import { devPreviewAffordanceText, devPreviewAffordanceVerb, shouldShowDevPreviewAffordance } from './dev-preview-copy';

/** The affordance polls slowly: a dev server coming up is a seconds-scale event, and every tick is a control-plane read. */
const AFFORDANCE_POLL_MS = 15_000;

export function DevPreviewAffordance({
  statusPath,
  title,
  active = true,
  pauseWhenIdle = true,
  className,
}: {
  /** The reader's status route — session or env. */
  statusPath: string;
  /** The session or environment name, for the pane's chrome. */
  title: string;
  /** The caller's disclosure: poll only while true; a toggle re-arms an idle-paused poll. */
  active?: boolean;
  /** Stop polling after four idle answers (per-row surfaces); a per-viewer surface with no disclosure passes false. */
  pauseWhenIdle?: boolean;
  className?: string;
}) {
  const enabled = useDevPreviewCapability();
  const openPreview = useDevPreviewPaneStore((state) => state.openPreview);
  const openStatusPath = useDevPreviewPaneStore((state) => state.open?.statusPath ?? null);
  const isOpen = openStatusPath === statusPath;
  const { preview } = useDevPreviewStatus(statusPath, { enabled: enabled === true, active, paneOwnsPoll: isOpen, pauseWhenIdle, intervalMs: AFFORDANCE_POLL_MS });

  if (enabled !== true || !shouldShowDevPreviewAffordance(preview)) return null;
  const text = devPreviewAffordanceText(preview);
  const openPath = preview.openPath;
  const verb = devPreviewAffordanceVerb(preview);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)} data-testid="dev-preview-affordance">
      <Globe className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate" title={preview.state.message}>
        {text}
      </span>
      {openPath !== null && (
        <>
          <span aria-hidden="true">—</span>
          <button
            type="button"
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
            disabled={isOpen}
            aria-pressed={isOpen}
            onClick={(event) => {
              // A row's own click targets (its context menu, its disclosure) must not also fire.
              event.stopPropagation();
              openPreview({
                holder: preview.holder,
                statusPath,
                actionsPath: `${statusPath}/actions`,
                openPath,
                title,
              });
            }}
          >
            {isOpen ? 'Open' : verb}
          </button>
        </>
      )}
    </div>
  );
}
