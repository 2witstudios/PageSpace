import { NextResponse } from 'next/server';
import { ConversationHistoryDeletedError } from '@/lib/repositories/resolve-or-create-conversation';
import { contentBlockedResponseFor } from '@/lib/upload/content-blocked-response';

/**
 * The failures of a user-message save that are the caller's to hear about as a
 * 4xx rather than a 500 — shared by the page and global turns so the mapping
 * has one home:
 *
 *   - the conversation's history was deleted while the turn was starting → 404;
 *   - an attachment is on the content blocklist → the neutral upload refusal.
 *     The save runs before generation, so the turn stops before the model ever
 *     sees the file.
 *
 * Returns null for anything else; the turn keeps its own 500 handling.
 */
export function userMessageSaveRefusal(error: unknown): NextResponse | null {
  if (error instanceof ConversationHistoryDeletedError) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  return contentBlockedResponseFor(error);
}
