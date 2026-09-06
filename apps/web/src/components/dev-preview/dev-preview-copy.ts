/**
 * Pure presentation over the status DTO: a short label + tone per state for
 * the badge, and the one-line affordance text. The MESSAGE is never composed
 * here — it is the server's (`describeServiceState`, the status module), so
 * every honest sentence a user reads has one home; this file only decides
 * how loud to be about it.
 */

import type { DevPreviewStateDTO, DevPreviewStatusDTO } from '@/hooks/dev-preview/useDevPreviewStatus';

export type BadgeTone = 'default' | 'secondary' | 'destructive' | 'outline';

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
    case 'stale':
      return { label: 'Sandbox rebuilt', tone: 'outline' };
    case 'instance-unknown':
      return { label: 'Unavailable', tone: 'outline' };
    case 'none':
      return { label: 'No dev server', tone: 'outline' };
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
      return `Dev server on :${state.targetPort} is not responding`;
    case 'blocked':
      return `Dev server on :${state.targetPort} — port 8080 is in use`;
    case 'stopped':
      return `Preview of :${state.targetPort} is switched off`;
    case 'stale':
      return `Preview of :${state.targetPort} needs the dev server started again`;
    case 'instance-unknown':
      return 'Preview state unavailable';
    case 'none':
      return null;
  }
}

/** Whether the affordance should render at all for this status. */
export function shouldShowDevPreviewAffordance(preview: DevPreviewStatusDTO | undefined): preview is DevPreviewStatusDTO {
  return preview !== undefined && devPreviewAffordanceText(preview) !== null;
}
