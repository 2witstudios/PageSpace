/**
 * The dev-preview FRAME CONTRACT — the one message the preview origin sends
 * the dashboard, defined once so the sender (the re-auth page the host route
 * serves, `preview-grant.ts`) and the receiver (the pane) cannot drift.
 *
 * Pure and dependency-free on purpose: this module is imported by the CLIENT
 * bundle, so it must pull in no server-only code.
 */

import type { DevPreviewHolderRef } from './dev-preview-core';

/** `event.data.type` of every message the preview origin posts to the dashboard. */
export const DEV_PREVIEW_MESSAGE_TYPE = 'pagespace:dev-preview';
/** The preview cookie expired inside the frame: re-run the handshake from the app origin. */
export const DEV_PREVIEW_REAUTH_EVENT = 'reauth-required';

export interface DevPreviewReauthMessage {
  type: typeof DEV_PREVIEW_MESSAGE_TYPE;
  event: typeof DEV_PREVIEW_REAUTH_EVENT;
  holder: DevPreviewHolderRef;
}

/** Pure: is this a re-auth request about `holder`? Anything else (other shapes, other holders) is not. */
export function isDevPreviewReauthMessageFor(data: unknown, holder: DevPreviewHolderRef): data is DevPreviewReauthMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Partial<DevPreviewReauthMessage>;
  return (
    message.type === DEV_PREVIEW_MESSAGE_TYPE &&
    message.event === DEV_PREVIEW_REAUTH_EVENT &&
    typeof message.holder === 'object' &&
    message.holder !== null &&
    message.holder.kind === holder.kind &&
    message.holder.id === holder.id
  );
}
