import { NextResponse } from 'next/server';
import {
  ContentBlockedError,
  CONTENT_BLOCKED_MESSAGE,
  CONTENT_BLOCKED_STATUS,
} from '@pagespace/lib/content-safety/policy';

/**
 * The one neutral refusal for blocklisted content. It gives no reason: it must
 * not confirm that a file is on a blocklist.
 */
export function contentBlockedResponse(): NextResponse {
  return NextResponse.json({ error: CONTENT_BLOCKED_MESSAGE }, { status: CONTENT_BLOCKED_STATUS });
}

/**
 * Map a ContentBlockedError thrown while persisting a chat attachment to that
 * refusal. Returns null for anything else so the caller keeps its own error
 * handling. Nothing the error carries (the hash) reaches the client.
 */
export function contentBlockedResponseFor(error: unknown): NextResponse | null {
  return error instanceof ContentBlockedError ? contentBlockedResponse() : null;
}
