import { NextResponse } from 'next/server';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';

/**
 * The one answer for a file whose bytes were taken down.
 *
 * A takedown deletes the objects but leaves the rows that point at them, so a
 * reader would otherwise redirect to a dead storage link. Every route that
 * serves a file by content hash asks here first and answers 410 with this
 * neutral message: it says the file is gone and nothing about why.
 *
 * The blocklist is the source of truth, not the bucket: a blocked hash answers
 * 410 even while a takedown is still waiting to delete it (for example a CSAM
 * case held at the evidence step), so blocked bytes are never served.
 *
 * Call it AFTER the caller's permission check, so the response tells someone
 * with no access to the file nothing about it.
 */
export const CONTENT_REMOVED_MESSAGE = 'This file has been removed';
export const CONTENT_REMOVED_STATUS = 410;

export function contentRemovedResponse(): NextResponse {
  return NextResponse.json(
    { error: CONTENT_REMOVED_MESSAGE },
    { status: CONTENT_REMOVED_STATUS, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** The 410 when the hash is blocked, otherwise null and the caller serves the file. */
export async function refuseRemovedContent(contentHash: string | null | undefined): Promise<NextResponse | null> {
  if (!contentHash) return null;
  return (await isHashBlocked(contentHash)) ? contentRemovedResponse() : null;
}
