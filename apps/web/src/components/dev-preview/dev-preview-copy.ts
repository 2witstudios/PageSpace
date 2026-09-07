/**
 * Pure presentation over the status DTO: a short label + tone per state for
 * the badge, and the one-line affordance text. The MESSAGE is never composed
 * here — it is the server's (`describeServiceState`, the status module), so
 * every honest sentence a user reads has one home; this file only decides
 * how loud to be about it.
 */

import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';
import type { DevPreviewStateDTO, DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

/** The Badge's own variant union — never a hand copy that stops typechecking against it. */
export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export function devPreviewBadge(state: DevPreviewStateDTO): { label: string; tone: BadgeTone } {
  switch (state.status) {
    case 'live':
      return { label: state.via === 'direct' ? `Live on :${state.targetPort}` : `Live · :${state.targetPort}`, tone: 'default' };
    case 'starting':
      return { label: `Starting · :${state.targetPort}`, tone: 'secondary' };
    case 'down':
      return { label: `Down · :${state.targetPort}`, tone: 'destructive' };
    case 'blocked':
      return { label: 'Port 8080 in use', tone: 'destructive' };
    case 'stopped':
      return { label: `Off · :${state.targetPort}`, tone: 'outline' };
    case 'needs-approval':
      return { label: `Needs your OK · :${state.targetPort}`, tone: 'secondary' };
    case 'stale':
      return { label: 'Sandbox rebuilt', tone: 'outline' };
    case 'instance-unknown':
      return { label: 'Unavailable', tone: 'outline' };
    case 'none':
      return { label: 'No dev server', tone: 'outline' };
    default:
      // A status this build does not know (the union can grow a member before
      // every reader is updated) must never TypeError the pane subtree or
      // render an empty label — the `STATUS_COPY` lesson from the app pane.
      return { label: 'Unknown state', tone: 'outline' };
  }
}

/**
 * The affordance line. Only states that describe a KNOWN dev server earn a
 * line at all — `none` renders nothing (the whole point of "unobtrusive":
 * a session with no dev server shows no preview chrome), and so does an
 * unreachable/absent sandbox with nothing recorded.
 */
export function devPreviewAffordanceText(preview: DevPreviewStatusDTO): string | null {
  const { state } = preview;
  switch (state.status) {
    case 'live':
    case 'starting':
      return `Dev server detected on :${state.targetPort}`;
    case 'down':
      // "not running", not "not responding": a `down` preview is as often a
      // relay that was never created — the dev server itself may be perfectly
      // healthy, and telling the user it is not responding sends them looking
      // in the wrong place. The pane's status line carries the precise reason.
      return `Preview of :${state.targetPort} is not running`;
    case 'blocked':
      return `Dev server on :${state.targetPort} — port 8080 is in use`;
    case 'stopped':
      return `Preview of :${state.targetPort} is switched off`;
    case 'needs-approval':
      return `Dev server detected on :${state.targetPort} — not shared yet`;
    case 'stale':
      return `Preview of :${state.targetPort} needs the dev server started again`;
    case 'instance-unknown':
      return 'Preview state unavailable';
    case 'none':
      return null;
    default:
      return 'Preview state unknown';
  }
}

/**
 * The affordance's verb: "Preview" only when the frame would actually show
 * something (`canOpen`); otherwise "Details" — opening the pane on a down,
 * blocked, stopped or stale preview shows its status and controls, not a
 * live app, and the button should not promise one.
 */
export function devPreviewAffordanceVerb(preview: DevPreviewStatusDTO): 'Preview' | 'Details' {
  return preview.canOpen ? 'Preview' : 'Details';
}

/** Whether the affordance should render at all for this status. */
export function shouldShowDevPreviewAffordance(preview: DevPreviewStatusDTO | undefined): preview is DevPreviewStatusDTO {
  return preview !== undefined && devPreviewAffordanceText(preview) !== null;
}

/**
 * WHO would be able to reach the preview once it is shared — the sentence the
 * approval control is placed under, because "share" means nothing without it.
 * An env's preview is viewable by every accepted member of the drive (the
 * env routes' own GET bar); a session's is viewable by whoever may open that
 * session. Neither is a guess: both restate the access decision the proxy
 * enforces on every request.
 */
export function devPreviewApprovalAudience(holder: DevPreviewStatusDTO['holder']): string {
  return holder.kind === 'env'
    ? 'Everyone with access to this drive will be able to open it.'
    : 'Anyone who can open this session will be able to open it.';
}
