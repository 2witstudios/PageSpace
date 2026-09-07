/**
 * The body of a dev-preview user action (`POST …/preview/actions`): exactly
 * `{ action: 'stop' | 'resume' }`. One parser for the session and env routes
 * so "well-formed" cannot drift between them.
 */

import type { DevPreviewUserAction } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

/** Pure: the action named by a request body, or null for anything else. */
export function readDevPreviewUserAction(body: unknown): DevPreviewUserAction | null {
  if (typeof body !== 'object' || body === null) return null;
  const action = (body as { action?: unknown }).action;
  return action === 'stop' || action === 'resume' ? action : null;
}
