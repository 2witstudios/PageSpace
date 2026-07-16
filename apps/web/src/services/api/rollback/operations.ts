/**
 * Rollback operation vocabulary
 *
 * Pure, effect-free constants and predicates describing which activity
 * operations exist, how they are labelled, and which handlers may proceed
 * without a stored target value. Extracted from rollback-service.ts so the
 * whitelist cannot drift between the preview and the agent-config handlers.
 */
import type { ActivityOperation } from '@pagespace/lib/monitoring/activity-logger';

/**
 * Valid activity operations for filtering
 */
export const VALID_OPERATIONS = [
  'create', 'update', 'delete', 'restore', 'reorder',
  'permission_grant', 'permission_update', 'permission_revoke',
  'trash', 'move', 'agent_config_update',
  'member_add', 'member_remove', 'member_role_change',
  'login', 'logout', 'signup', 'email_change',
  'token_create', 'token_revoke', 'upload', 'convert',
  'account_delete', 'profile_update', 'avatar_update',
  'message_update', 'message_delete', 'role_reorder', 'ownership_transfer',
  'rollback', 'conversation_undo', 'conversation_undo_with_changes',
] as const;

/**
 * Check if a string is a valid activity operation
 */
export function isValidOperation(operation: string): boolean {
  return VALID_OPERATIONS.includes(operation as typeof VALID_OPERATIONS[number]);
}

export const OPERATION_SUMMARY_LABELS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  restore: 'Restore',
  reorder: 'Reorder',
  trash: 'Trash',
  move: 'Move',
  permission_grant: 'Grant permission',
  permission_update: 'Update permission',
  permission_revoke: 'Revoke permission',
  agent_config_update: 'Update agent',
  member_add: 'Add member',
  member_remove: 'Remove member',
  member_role_change: 'Change member role',
  role_reorder: 'Reorder roles',
  ownership_transfer: 'Transfer ownership',
  message_update: 'Edit message',
  message_delete: 'Delete message',
  rollback: 'Rollback',
};

export function getOperationSummaryLabel(operation: string): string {
  return OPERATION_SUMMARY_LABELS[operation] ?? operation;
}

export const REDO_ALLOW_MISSING_TARGET = new Set<ActivityOperation>([
  'member_remove',
  'permission_revoke',
  'delete',
  'trash',
]);

export const ROLLBACK_ALLOW_MISSING_TARGET = new Set<ActivityOperation>([
  'permission_grant',
  'member_add',
  'message_delete',
]);

// Every field update_agent_config (apps/web/src/lib/ai/tools/agent-tools.ts) can
// write to the pages table for an AI_CHAT agent — kept in sync with that tool's
// AgentUpdateData so a config change is always undo/redo-able via rollback.
export const AGENT_CONFIG_ROLLBACK_FIELDS = [
  'systemPrompt',
  'enabledTools',
  'aiProvider',
  'aiModel',
  'includeDrivePrompt',
  'agentDefinition',
  'visibleToGlobalAssistant',
  'includePageTree',
  'pageTreeScope',
  'toolExposureMode',
  'userScopedAccess',
] as const;
