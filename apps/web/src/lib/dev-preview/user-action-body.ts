/**
 * The body of a dev-preview user action (`POST …/preview/actions`):
 * `{ action: 'stop' | 'resume' }`, or `{ action: 'approve', port }`. One
 * parser for the session and env routes so "well-formed" cannot drift
 * between them.
 *
 * The echoed `port` on an approve is SECURITY-RELEVANT, not a convenience:
 * it binds the click to the port the user was actually shown. A dev server
 * that moved between the render and the click therefore cannot be shared by
 * a click that meant the old one — the store's filtered write refuses it and
 * the route answers 409.
 */

import type { DevPreviewUserAction } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

/** Pure: the action named by a request body, or null for anything else. */
export function readDevPreviewUserAction(body: unknown): DevPreviewUserAction | null {
  if (typeof body !== 'object' || body === null) return null;
  const { action, port } = body as { action?: unknown; port?: unknown };
  if (action === 'stop' || action === 'resume') return { kind: action };
  if (action !== 'approve') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: 'approve', port };
}
