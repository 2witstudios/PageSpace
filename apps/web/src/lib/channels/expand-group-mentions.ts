import {
  getDriveRecipientUserIds,
  getDriveMemberUserIdsByStandardRole,
  getDriveMemberUserIdsByCustomRole,
} from '@pagespace/lib/services/drive-member-service';
import { extractMentionedUserIds } from './extract-user-mentions';

const STANDARD_ROLES = new Set(['OWNER', 'ADMIN', 'MEMBER'] as const);
type StandardRole = 'OWNER' | 'ADMIN' | 'MEMBER';

function isStandardRole(id: string): id is StandardRole {
  return STANDARD_ROLES.has(id as StandardRole);
}

/**
 * Extract raw group mention tokens from content without expanding to user IDs.
 * Returns `{ type: 'everyone' }` entries and `{ type: 'role', roleId }` entries.
 */
export function extractGroupMentions(
  content: string,
): Array<{ type: 'everyone' } | { type: 'role'; roleId: string }> {
  if (!content || content.length === 0) return [];

  const results: Array<{ type: 'everyone' } | { type: 'role'; roleId: string }> = [];
  const seen = new Set<string>();

  const re = /@\[[^\]]{1,500}\]\(([^:)]{1,200}):(everyone|role)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    const type = m[2] as 'everyone' | 'role';
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (type === 'everyone') {
      results.push({ type: 'everyone' });
    } else {
      results.push({ type: 'role', roleId: id });
    }
  }

  return results;
}

/**
 * Expand all user, @everyone, and @role mentions in content to a deduplicated
 * list of user IDs. Group mentions are resolved via DB queries against the
 * given driveId.
 */
export async function expandMentionsToUserIds(
  content: string,
  driveId: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  const addIds = (ids: string[]) => {
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  };

  // Individual user mentions
  addIds(extractMentionedUserIds(content));

  const groupMentions = extractGroupMentions(content);
  if (groupMentions.length === 0) return out;

  let hasEveryone = false;
  const roleIds: string[] = [];

  for (const gm of groupMentions) {
    if (gm.type === 'everyone') {
      hasEveryone = true;
    } else {
      roleIds.push(gm.roleId);
    }
  }

  // @everyone — owner + all accepted members
  if (hasEveryone) {
    addIds(await getDriveRecipientUserIds(driveId));
  }

  // @role mentions — expand each unique role
  for (const roleId of roleIds) {
    const ids = isStandardRole(roleId)
      ? await getDriveMemberUserIdsByStandardRole(driveId, roleId)
      : await getDriveMemberUserIdsByCustomRole(driveId, roleId);
    addIds(ids);
  }

  return out;
}
