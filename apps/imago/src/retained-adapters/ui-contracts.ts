import type { UIMessage } from 'ai';
import type { AttachmentMeta } from '@pagespace/lib/types';
export type { PresenceViewer, PresencePageViewersPayload } from '@pagespace/lib/types';
export type { AccessRevokedPayload } from '@pagespace/lib/realtime/kick-client';
import { z } from 'zod';
import { PALETTE, MAX_DECIMALS, MIN_FONT_SIZE, MAX_FONT_SIZE, MAX_ADDRESSABLE_ROW, MAX_REGION_HEADER_ROWS, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, type ConditionalOperator } from '@pagespace/lib/sheets/sheet';
/** Generated UI declarations from classic sources by build-ui-contracts.ts. */
import type { PageType } from '@pagespace/lib/utils/enums';
import type { ConversationAccessRow } from '@pagespace/lib/permissions/conversation-access';
import type { ActivityActionPreview } from '@/retained/types/activity-actions';
// lib/websocket/conversation-events.ts#ConversationEventScope
export type ConversationEventScope =
  | { kind: 'page'; pageId: string }
  | { kind: 'global'; ownerId: string };
// lib/websocket/conversation-events.ts#ConversationEventTriggeredBy
export interface ConversationEventTriggeredBy {
  userId: string;
  browserSessionId: string;
}
// lib/websocket/conversation-events.ts#ConversationEventBase
export interface ConversationEventBase {
  conversationId: string;
  /**
   * The post-write `conversations.rev`. 0 when the conversation has no row
   * (legacy page conversations) — subscribers treat that as "no watermark,
   * refetch on doubt".
   */
  rev: number;
  scope: ConversationEventScope;
  triggeredBy: ConversationEventTriggeredBy;
}
// lib/websocket/conversation-events.ts#ConversationMessageRef
export interface ConversationMessageRef {
  id: string;
  role: string;
  status: string;
  /**
   * ABSENT when the message carries no timestamp — never "now" (review
   * finding). `createdAt` is the key clients order on, so a fabricated one is
   * the single value guaranteed to be wrong for the messages that reach this
   * shape: a backfill or a replay lands at the bottom of the transcript rather
   * than where it belongs. Missing is a fact a reader can act on; a plausible
   * wrong answer is not.
   */
  createdAt?: string;
}
// lib/websocket/conversation-events.ts#ConversationMessagePayload
export type ConversationMessagePayload = ConversationEventBase &
  (
    | { message: UIMessage; truncated?: undefined }
    | { messageRef: ConversationMessageRef; truncated: true }
  );
// lib/websocket/conversation-events.ts#ConversationMessageDeletedPayload
export interface ConversationMessageDeletedPayload extends ConversationEventBase {
  messageId: string;
}
// lib/websocket/conversation-events.ts#ConversationUndoAppliedPayload
export interface ConversationUndoAppliedPayload extends ConversationEventBase {
  mode: 'messages_only' | 'messages_and_changes';
  affectedMessageIds: string[];
}
// lib/websocket/conversation-events.ts#ConversationChangedFields
export interface ConversationChangedFields {
  title?: string | null;
  lastMessageAt?: string | null;
  isShared?: boolean;
  /**
   * The bound plan page, or null when unbound. On the wire because `PlanChip`
   * renders it: without a field here (and the matching rev bump) a second pane
   * on the same conversation sees an unchanged rev, which it cannot tell apart
   * from "nothing happened", and shows no chip — or a stale one after
   * `clear_plan` — until a reload.
   */
  planPageId?: string | null;
}
// lib/websocket/conversation-events.ts#ConversationDirectoryPayload
export interface ConversationDirectoryPayload extends ConversationEventBase {
  changes?: ConversationChangedFields;
  /** Present on `conversation:created` so sidebars can insert without a fetch. */
  conversation?: {
    id: string;
    title: string | null;
    type: string;
    contextId: string | null;
    isShared: boolean;
    createdAt: string;
    lastMessageAt: string | null;
  };
}
// lib/websocket/socket-utils.ts#PageOperation
export type PageOperation = 'created' | 'updated' | 'moved' | 'deleted' | 'restored' | 'trashed' | 'content-updated';
// lib/websocket/socket-utils.ts#DriveOperation
export type DriveOperation = 'created' | 'updated' | 'deleted';
// lib/websocket/socket-utils.ts#DriveMemberOperation
export type DriveMemberOperation = 'member_added' | 'member_role_changed' | 'member_removed';
// lib/websocket/socket-utils.ts#TaskOperation
export type TaskOperation = 'task_list_created' | 'task_added' | 'task_updated' | 'task_completed' | 'task_deleted' | 'tasks_reordered';
// lib/websocket/socket-utils.ts#CreditsOperation
export type CreditsOperation = 'updated';
// lib/websocket/socket-utils.ts#InboxOperation
export type InboxOperation = 'dm_updated' | 'channel_updated' | 'read_status_changed' | 'thread_updated';
// lib/websocket/socket-utils.ts#ActivityEventPayload
export interface ActivityEventPayload {
  activityId: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  userId: string;
  timestamp: string;
}
// lib/websocket/socket-utils.ts#PageEventPayload
export interface PageEventPayload {
  driveId: string;
  pageId: string;
  parentId?: string | null;
  operation: PageOperation;
  title?: string;
  type?: string;
  isPrivate?: boolean;
  socketId?: string; // Socket ID of the user who triggered this event (to prevent self-refetch)
}
// lib/websocket/socket-utils.ts#DriveEventPayload
export interface DriveEventPayload {
  driveId: string;
  operation: DriveOperation;
  name?: string;
  slug?: string;
  /** Discriminates command/workflow broadcasts from drive-level changes. Absent = drive-level. */
  resourceType?: 'command' | 'workflow';
}
// lib/websocket/socket-utils.ts#DriveMemberEventPayload
export interface DriveMemberEventPayload {
  driveId: string;
  userId: string; // The affected user
  operation: DriveMemberOperation;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
  driveName?: string;
}
// lib/websocket/socket-utils.ts#TaskEventPayload
export interface TaskEventPayload {
  type: TaskOperation;
  taskId?: string;
  taskListId?: string;
  pageId?: string;
  userId: string;
  data: {
    [key: string]: unknown;
  };
}
// lib/websocket/socket-utils.ts#CreditsEventPayload
export interface CreditsEventPayload {
  userId: string;
  operation: CreditsOperation;
  billingEnabled: boolean;
  monthly: {
    remaining: number;
    allowance: number;
    periodEnd: string | null;
  };
  topup: {
    remaining: number;
  };
  /** Outstanding overage owed (non-negative). When > 0, `spendable` is negative. */
  debt: number;
  spendable: number;
  reserved: number;
  conversationId?: string;
  pageId?: string;
}
// lib/websocket/socket-utils.ts#InboxEventPayload
export interface InboxEventPayload {
  operation: InboxOperation;
  type: 'dm' | 'channel';
  id: string;
  driveId?: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  lastMessageSender?: string;
  unreadCount?: number;
  attachmentMeta?: AttachmentMeta | null;
  // thread_updated-only fields. Added inline (rather than as a discriminated
  // union) so existing call sites keep compiling — only thread_updated emitters
  // populate these. Recipients are computed at the call site from
  // `listFollowers`; the payload itself does not carry a recipient list.
  rootMessageId?: string;
  lastReplyAt?: string;
  lastReplyPreview?: string;
  lastReplySender?: { id: string; name: string };
}
// lib/websocket/socket-utils.ts#ThreadReplyCountUpdatedPayload
export interface ThreadReplyCountUpdatedPayload {
  rootId: string;
  replyCount: number;
  lastReplyAt: string;
}
// lib/websocket/socket-utils.ts#AiStreamStartPayload
export interface AiStreamStartPayload {
  messageId: string;
  pageId: string;
  conversationId: string;
  /**
   * ISO timestamp of the stream's `aiStreamSessions.started_at`, so remote
   * surfaces can stamp synthesized bubbles. Optional for cross-version safety:
   * during a rolling deploy an originator running the previous build emits this
   * event without the field, and consumers degrade to a timestamp-less bubble.
   */
  startedAt?: string;
  /**
   * Whether the stream's conversation is explicitly shared.
   *
   * A page room contains every member of the page, but conversations are PRIVATE by
   * default (`listConversations` shows you only `userId = you OR isShared`). Without
   * this flag every member's client would try to join every stream on the page and be
   * refused — a wasted request and an `authz.access.denied` audit row per member per
   * assistant message, on entirely routine private chat.
   *
   * Optional for the same cross-version reason as `startedAt`: during a rolling deploy
   * an originator on the previous build emits no field, so consumers must treat
   * `undefined` as "unknown, ask the server" and only skip on an explicit `false`.
   * The server remains the authority either way (see stream-subscription-authz.ts).
   */
  isShared?: boolean;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#AiStreamCompletePayload
export interface AiStreamCompletePayload {
  messageId: string;
  pageId: string;
  conversationId?: string;
  aborted?: boolean;
}
// lib/websocket/socket-utils.ts#ChatUserMessagePayload
export interface ChatUserMessagePayload {
  message: import('ai').UIMessage;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatMessageEditedPayload
export interface ChatMessageEditedPayload {
  messageId: string;
  pageId: string;
  conversationId: string;
  parts: import('ai').UIMessage['parts'];
  editedAt: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatMessageDeletedPayload
export interface ChatMessageDeletedPayload {
  messageId: string;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatUndoAppliedPayload
export interface ChatUndoAppliedPayload {
  conversationId: string;
  pageId: string;
  mode: 'messages_only' | 'messages_and_changes';
  affectedMessageIds: string[];
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatConversationAddedPayload
export interface ChatConversationAddedPayload {
  agentId: string;
  conversation: {
    id: string;
    title: string;
    createdAt: string;
  };
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatGlobalConversationAddedPayload
export interface ChatGlobalConversationAddedPayload {
  conversation: {
    id: string;
    title: string;
    type: string;
    createdAt: string;
  };
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatConversationRenamedPayload
export interface ChatConversationRenamedPayload {
  agentId: string;
  conversationId: string;
  title: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#ChatConversationDeletedPayload
export interface ChatConversationDeletedPayload {
  agentId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}
// lib/websocket/socket-utils.ts#AgentGrantChangedPayload
export interface AgentGrantChangedPayload {
  agentId: string;
  triggeredBy: { userId: string };
}
// lib/websocket/socket-utils.ts#ShellActivityEventPayload
export interface ShellActivityEventPayload {
  /** The session whose sandbox the agent acted on — ≡ its conversation id. */
  sessionId: string;
  command: string;
  output: string;
  exitCode: number;
  agentLabel: string;
}
// app/api/user/favorites/route.ts#FavoriteItem
export type FavoriteItem = {
  id: string;
  itemType: 'page' | 'drive';
  position: number;
  createdAt: string;
  page?: {
    id: string;
    title: string;
    type: string;
    driveId: string;
    driveName: string;
  };
  drive?: {
    id: string;
    name: string;
  };
};
// app/api/user/recents/route.ts#RecentPage
export type RecentPage = {
  id: string;
  title: string;
  type: PageType;
  driveId: string;
  driveName: string;
  viewedAt: string;
};
// services/api/permission-management-service.ts#RolePermissionFlags
export interface RolePermissionFlags {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
}
// services/api/permission-management-service.ts#RoleGrant
export interface RoleGrant extends RolePermissionFlags {
  roleId: string;
  name: string;
  color: string | null;
}
// services/api/ai-undo-service.ts#MessageSource
export type MessageSource = 'page_chat' | 'global_chat';
// services/api/ai-undo-service.ts#AiUndoPreview
export interface AiUndoPreview {
  messageId: string;
  conversationId: string;
  pageId: string | null;
  /**
   * The conversation's own facts — owner, shared flag, type and page — so the
   * route can run `canAccessConversation` on a DESTRUCTIVE conversation-scoped
   * verb rather than gating on page permission alone (review finding). Null
   * when the message has no conversation row, which the gate denies.
   */
  conversationAccess: ConversationAccessRow | null;
  driveId: string | null;
  source: MessageSource;
  createdAt: Date; // Message creation timestamp for undo cutoff
  messagesAffected: number;
  activitiesAffected: {
    id: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    resourceTitle: string | null;
    pageId?: string | null;
    driveId?: string | null;
    metadata?: Record<string, unknown> | null;
    preview: ActivityActionPreview;
  }[];
  warnings: string[];
}
// services/api/ai-undo-service.ts#UndoMode
export type UndoMode = 'messages_only' | 'messages_and_changes';
// services/api/rollback-to-point-service.ts#RollbackToPointContext
export type RollbackToPointContext = 'page' | 'drive' | 'user_dashboard';
// services/api/rollback-to-point-service.ts#RollbackToPointPreview
export interface RollbackToPointPreview {
  activityId: string;
  context: RollbackToPointContext;
  pageId: string | null;
  driveId: string | null;
  timestamp: Date;
  activitiesAffected: {
    id: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    resourceTitle: string | null;
    pageId: string | null;
    driveId: string | null;
    timestamp: Date;
    actorEmail: string | null;
    actorDisplayName: string | null;
    isAiGenerated: boolean;
    preview: ActivityActionPreview;
  }[];
  warnings: string[];
}
// services/api/drive-backup-service.ts#DriveBackupSource
export type DriveBackupSource = 'manual' | 'scheduled' | 'pre_restore' | 'system';
// services/api/drive-backup-service.ts#DriveBackupSummary
export interface DriveBackupSummary {
  id: string;
  driveId: string;
  createdAt: Date;
  createdBy: string | null;
  source: DriveBackupSource;
  status: 'pending' | 'ready' | 'failed';
  label: string | null;
  reason: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
}
// services/api/drive-backup-service.ts#DriveBackupWithDriveName
export type DriveBackupWithDriveName = DriveBackupSummary & { driveName: string | null; driveSlug: string | null };
// services/api/snapshot-pages-service.ts#SnapshotPageNode
export interface SnapshotPageNode {
  pageId: string;
  title: string | null;
  type: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  stateHash: string | null;
  content?: string;
  children: SnapshotPageNode[];
}
// services/api/restore-diff-service.ts#RestoreDiff
export type RestoreDiff = {
  toCreate:    { pageId: string; title: string; type: string }[];
  toOverwrite: { pageId: string; title: string; type: string; currentHash: string | null; backupHash: string | null }[];
  toOrphan:    { pageId: string; title: string }[];
  unchanged:   { pageId: string }[];
};
// lib/ai/tools/sheet-format-tools.ts#HUE_NAMES
const HUE_NAMES = PALETTE.map((hue) => hue.name) as [string, ...string[]];
// lib/ai/tools/sheet-format-tools.ts#aiNumberFormatSchema
const aiNumberFormatSchema = z
  .object({
    kind: z.enum(['auto', 'plain', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'scientific', 'text']),
    decimals: z.number().int().min(0).max(MAX_DECIMALS).optional(),
    currency: z.string().length(3).optional().describe('ISO 4217.'),
    thousands: z.boolean().optional(),
    dateStyle: z.enum(['short', 'medium', 'long', 'iso']).optional(),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#aiCellFormatSchema
const aiCellFormatSchema = z
  .object({
    number: aiNumberFormatSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    valign: z.enum(['top', 'middle', 'bottom']).optional(),
    wrap: z.boolean().optional(),
    color: z.string().optional().describe('#rrggbb'),
    background: z.string().optional().describe('#rrggbb'),
    fontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE).optional(),
    fontFamily: z.enum(['sans', 'mono']).optional(),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#columnSchema
const columnSchema = z.string().regex(/^[A-Za-z]{1,7}$/, 'Column must be letters, e.g. "A" or "AB"');
// lib/ai/tools/sheet-format-tools.ts#rangeSchema
const rangeSchema = z.string().describe('A1 range, e.g. "B2:D40".');
// lib/ai/tools/sheet-format-tools.ts#rowNumberSchema
const rowNumberSchema = z.number().int().min(1).max(MAX_ADDRESSABLE_ROW + 1);
// lib/ai/tools/sheet-format-tools.ts#countSchema
const countSchema = z.number().int().min(0).max(MAX_ADDRESSABLE_ROW + 1);
// lib/ai/tools/sheet-format-tools.ts#COLUMN_ROLES
const COLUMN_ROLES = ['text', 'number', 'currency', 'percent', 'date', 'datetime', 'id'] as const;
// lib/ai/tools/sheet-format-tools.ts#regionColumnSchema
const regionColumnSchema = z
  .object({
    column: columnSchema,
    role: z.enum(COLUMN_ROLES),
    currency: z.string().length(3).optional(),
    decimals: z.number().int().min(0).max(MAX_DECIMALS).optional(),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#regionSchema
export const regionSchema = z
  .object({
    id: z.string().min(1).optional().describe('Omit for a new region.'),
    name: z.string().optional(),
    range: z.string().describe('"A1:F40", or "A1:F" to the end of the sheet.'),
    headerRows: z.number().int().min(0).max(MAX_REGION_HEADER_ROWS).optional().describe('Default 1.'),
    totalRows: z.array(rowNumberSchema).max(64).optional().describe('1-based total rows.'),
    columns: z.array(regionColumnSchema).max(64).optional(),
    theme: z.enum(HUE_NAMES).optional().describe('Accent hue.'),
    freezeHeader: z.boolean().optional().describe('Pin the header rows (region must start at row 1).'),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#RegionInput
export type RegionInput = z.infer<typeof regionSchema>;
// lib/ai/tools/sheet-format-tools.ts#FORMAT_OPS
const FORMAT_OPS = ['setFormat', 'clearFormat', 'columnFormat', 'columnWidth', 'rowHeight', 'freeze'] as const;
// lib/ai/tools/sheet-format-tools.ts#formatOpSchema
export const formatOpSchema = z
  .object({
    op: z
      .enum(FORMAT_OPS)
      .describe(
        'setFormat: range+format. clearFormat: range. columnFormat: column+format. columnWidth: ' +
        'column+width|clear. rowHeight: row+height|clear. freeze: frozenRows/frozenColumns|clear.'
      ),
    range: z.string().optional(),
    column: columnSchema.optional(),
    row: rowNumberSchema.optional().describe('1-based.'),
    format: aiCellFormatSchema.optional(),
    width: z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH).optional().describe('px'),
    height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).optional().describe('px'),
    frozenRows: countSchema.optional(),
    frozenColumns: countSchema.optional(),
    clear: z.literal(true).optional(),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#FormatOpInput
export type FormatOpInput = z.infer<typeof formatOpSchema>;
// lib/ai/tools/sheet-format-tools.ts#OPERATORS
const OPERATORS = [
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'equal',
  'notEqual',
  'between',
  'notBetween',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'isError',
] as const satisfies readonly ConditionalOperator[];
// lib/ai/tools/sheet-format-tools.ts#anchorSchema
const anchorSchema = z
  .object({
    type: z.enum(['min', 'max', 'number', 'percent', 'percentile']),
    value: z.number().optional().describe('For number/percent/percentile.'),
    color: z.string().optional().describe('#rrggbb; colorScale only.'),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#operandSchema
const operandSchema = z.union([z.string(), z.number()]);
// lib/ai/tools/sheet-format-tools.ts#ruleSchema
export const ruleSchema = z
  .object({
    kind: z.enum(['cell', 'formula', 'colorScale', 'dataBar']),
    ranges: z.array(rangeSchema).min(1).max(64).describe('Ranges the rule covers.'),
    operator: z.enum(OPERATORS).optional().describe('cell.'),
    value: operandSchema.optional().describe('cell: the operand. Not for isEmpty/isNotEmpty/isError.'),
    value2: operandSchema.optional().describe('cell: upper bound for between/notBetween.'),
    formula: z.string().max(4000).optional().describe('formula: e.g. "=C2>AVERAGE(C2:C40)", anchored at the range\'s top-left; ranges must be bounded.'),
    format: aiCellFormatSchema.optional().describe('cell/formula: applied where the rule matches.'),
    min: anchorSchema.optional().describe('colorScale (needs color) / dataBar.'),
    mid: anchorSchema.optional().describe('colorScale.'),
    max: anchorSchema.optional().describe('colorScale (needs color) / dataBar.'),
    color: z.string().optional().describe('dataBar: bar colour, #rrggbb.'),
  })
  .strict();
// lib/ai/tools/sheet-format-tools.ts#RuleInput
export type RuleInput = z.infer<typeof ruleSchema>;
// lib/ai/core/command-processor.ts#CommandSkipReason
export type CommandSkipReason = 'page_trashed' | 'no_access' | 'not_found' | 'disabled';
// lib/ai/core/command-processor.ts#COMMAND_SKIP_REASON_TEXT
export const COMMAND_SKIP_REASON_TEXT: Record<CommandSkipReason, string> = {
  page_trashed: 'its page is in the trash',
  no_access: 'you no longer have access to its page',
  not_found: 'the command no longer exists',
  disabled: 'the command is disabled',
};
// lib/ai/core/command-processor.ts#CommandExecutionData
export interface CommandExecutionData {
  label: string;
  status: 'used' | 'skipped';
  reason?: CommandSkipReason;
  entryPageTitle?: string;
}
