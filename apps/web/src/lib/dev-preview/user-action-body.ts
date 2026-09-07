/**
 * The body of a dev-preview user action (`POST …/preview/actions`):
 * `{ action: 'stop' | 'resume' }`, or `{ action: 'approve', port, spriteInstanceId }`. One
 * parser for the session and env routes so "well-formed" cannot drift
 * between them.
 *
 * The echoed `port` and `spriteInstanceId` on an approve are
 * SECURITY-RELEVANT, not conveniences: together they bind the click to the
 * exact thing the user was shown. A dev server that moved to another port
 * between the render and the click cannot be shared by a click that meant the
 * old one, and neither can a different VM's server of the same number after a
 * rebuild. The store's filtered write refuses both and the route answers 409.
 */

import type { DevPreviewUserAction } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

/** Pure: the action named by a request body, or null for anything else. */
export function readDevPreviewUserAction(body: unknown): DevPreviewUserAction | null {
  if (typeof body !== 'object' || body === null) return null;
  const { action, port, spriteInstanceId } = body as { action?: unknown; port?: unknown; spriteInstanceId?: unknown };
  if (action === 'stop' || action === 'resume') return { kind: action };
  if (action !== 'approve') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // The INSTANCE is echoed for the same reason the port is, one level up: a
  // rebuild replaces the row and can detect the same port again, so a click
  // made against the old sandbox must not approve the new one's server.
  if (typeof spriteInstanceId !== 'string' || spriteInstanceId.length === 0 || spriteInstanceId.length > 200) return null;
  return { kind: 'approve', port, spriteInstanceId };
}
