import { NextResponse } from 'next/server';
import {
  ContentBlockedError,
  CONTENT_BLOCKED_MESSAGE,
  CONTENT_BLOCKED_STATUS,
} from '@pagespace/lib/content-safety/policy';

/**
 * Map a ContentBlockedError thrown by a server-side writer (chat attachments,
 * generated images) to the same neutral refusal the upload routes return.
 * Returns null for anything else so the caller keeps its own error handling.
 *
 * The body is rebuilt from the constant rather than the error, so nothing the
 * error carries (the hash) can reach the client.
 */
export function contentBlockedResponseFor(error: unknown): NextResponse | null {
  if (!(error instanceof ContentBlockedError)) return null;
  return NextResponse.json({ error: CONTENT_BLOCKED_MESSAGE }, { status: CONTENT_BLOCKED_STATUS });
}
