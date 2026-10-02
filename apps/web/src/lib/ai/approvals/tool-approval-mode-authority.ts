/**
 * Who may change a page agent's `toolApprovalMode`.
 *
 * A page agent is shared: its mode applies to everyone who chats with it. So
 * the two directions are not symmetric:
 * - `ask` only makes the agent safer, so any principal that can edit the page
 *   may set it (the route has already checked edit access).
 * - `auto` turns the approval gate off for everyone. It requires a person in a
 *   browser session (not an MCP/OAuth/service token acting on their behalf)
 *   who is the drive's owner or an admin.
 *
 * Both agent-config routes call this, so both reject an invalid mode with 400.
 */

import { isSessionAuthResult, type AuthResult } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { isToolApprovalMode, type ToolApprovalMode } from './approval-policy';

export type ToolApprovalModeChange =
  | { ok: true; mode: ToolApprovalMode }
  | { ok: false; status: 400 | 403; error: string };

export async function authorizeToolApprovalModeChange(
  auth: AuthResult,
  driveId: string,
  requested: unknown,
): Promise<ToolApprovalModeChange> {
  if (!isToolApprovalMode(requested)) {
    return { ok: false, status: 400, error: 'toolApprovalMode must be "ask" or "auto"' };
  }
  if (requested === 'ask') return { ok: true, mode: requested };

  if (!isSessionAuthResult(auth)) {
    return {
      ok: false,
      status: 403,
      error: 'Turning tool approvals off ("auto") must be done by the drive owner or an admin from a signed-in session, not an API or MCP token',
    };
  }
  if (!(await isDriveOwnerOrAdmin(auth.userId, driveId))) {
    return {
      ok: false,
      status: 403,
      error: 'Only the drive owner or an admin can turn tool approvals off ("auto") for this shared agent',
    };
  }
  return { ok: true, mode: requested };
}
