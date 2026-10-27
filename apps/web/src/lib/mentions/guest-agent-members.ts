/**
 * Guest agent members for the @-mention picker.
 *
 * An agent is an AI_CHAT page. It belongs to a drive through
 * `drive_agent_members`, and that membership can point at a drive other than
 * the one its page lives in (a "guest" agent, added via the drive's Agents
 * settings). The picker's page search is keyed on `pages.driveId`, so a guest
 * agent can never come back from it — and the requester usually cannot view
 * the agent's HOME page at all. Membership in the channel's drive is the
 * grant: the drive's agent-members list already shows every such agent to
 * every drive member, and the mention responder accepts the same grant.
 *
 * Decision helpers are pure; the one DB read is injected at the route.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray, notInArray, type SQL } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import type { MentionSuggestion } from '@/types/mentions';

export interface GuestAgentRow {
  id: string;
  title: string | null;
  /** The drive the agent is a member of — the drive the picker is searching. */
  memberDriveId: string;
  /** Where the agent's page actually lives (never the member drive). */
  homeDriveId: string;
}

/**
 * Whether a page search should be widened with guest agent members. Every
 * narrowing a caller can express that excludes AI_CHAT pages excludes guest
 * agents too, so an image picker or the agent-pane page picker never sees one.
 */
export function shouldOfferGuestAgents(input: {
  requestedTypes: readonly string[];
  pageTypeParam: string | null;
  imageOnly: boolean;
  excludePageTypes: ReadonlySet<string>;
}): boolean {
  if (!input.requestedTypes.includes('page')) return false;
  if (input.imageOnly) return false;
  if (input.pageTypeParam !== null && input.pageTypeParam !== 'AI_CHAT') return false;
  if (input.excludePageTypes.has('AI_CHAT')) return false;
  return true;
}

/**
 * The picker row for a guest agent. `data.driveId` is the MEMBER drive — the
 * drive the channel belongs to — so the client keeps the drive context it is
 * already in; the home drive is deliberately not exposed.
 */
export function guestAgentSuggestion(
  row: GuestAgentRow,
  opts: { crossDrive: boolean; driveName: string | undefined },
): MentionSuggestion {
  const shortId = row.id.slice(0, 6);
  return {
    id: row.id,
    label: row.title || 'Agent',
    type: 'page',
    data: { pageType: 'AI_CHAT', driveId: row.memberDriveId, mimeType: null },
    description: opts.crossDrive && opts.driveName ? `agent in ${opts.driveName} · ${shortId}` : `agent · ${shortId}`,
  };
}

/**
 * AI_CHAT pages that are members of one of `memberDriveIds` but live in a
 * different drive. The caller must already have established that the
 * requester is a member/owner of every drive in `memberDriveIds`.
 */
export async function findGuestAgentMembers(input: {
  memberDriveIds: string[];
  /** The same title condition the in-drive page query uses; undefined = no filter. */
  searchCondition: SQL | undefined;
  limit?: number;
}): Promise<GuestAgentRow[]> {
  if (input.memberDriveIds.length === 0) return [];
  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      memberDriveId: driveAgentMembers.driveId,
      homeDriveId: pages.driveId,
    })
    .from(driveAgentMembers)
    .innerJoin(pages, eq(driveAgentMembers.agentPageId, pages.id))
    .where(
      and(
        inArray(driveAgentMembers.driveId, input.memberDriveIds),
        notInArray(pages.driveId, input.memberDriveIds),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false),
        input.searchCondition,
      ),
    )
    .limit(input.limit ?? 10);
  return rows;
}
