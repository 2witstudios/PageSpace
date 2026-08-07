import { eq, inArray, or, and, ne, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from '@pagespace/db/schema/auth';
import { agentWorkspaces, agentWorkspaceShells } from '@pagespace/db/schema/agent-workspaces';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { drives, pages } from '@pagespace/db/schema/core';
import { aiUsageLogs, activityLogs, systemLogs, apiMetrics, errorLogs, errorResolutions } from '@pagespace/db/schema/monitoring';
import { files, filePages } from '@pagespace/db/schema/storage';
import { driveMembers } from '@pagespace/db/schema/members';
import { channelMessages } from '@pagespace/db/schema/chat';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';
import { taskLists, taskItems } from '@pagespace/db/schema/tasks';
import { sessions } from '@pagespace/db/schema/sessions';
import { notifications } from '@pagespace/db/schema/notifications';
import { displayPreferences } from '@pagespace/db/schema/display-preferences';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { decryptUserRow } from '../../auth/user-repository';
import { getClickHouseGdprClient } from '../../observability/clickhouse-client';
import {
  collectChUserSystemLogs,
  collectChUserApiMetrics,
  collectChUserErrorLogs,
} from '../../observability/analytics-gdpr';

type DB = NodePgDatabase<Record<string, unknown>>;

/**
 * Analytics collectors below export the UNION of both stores. The CH leg
 * gates on CH being configured at ALL (getClickHouseGdprClient), not on the
 * write-cutover flag — a flag rollback after rows landed in CH must not omit
 * them from an Art 15 export (#890 Phase 3). No dedup is needed: at any
 * moment the flag routes each new row to exactly one store, and ids are
 * per-store cuid2s. CH read failures propagate (including the misconfigured
 * throw): an Art 15 export must be complete or fail.
 */
const clickHouseClientOrNull = () => getClickHouseGdprClient();

export interface UserProfileExport {
  id: string;
  name: string;
  email: string;
  image: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDriveExport {
  id: string;
  name: string;
  slug: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  createdAt: Date;
}

export interface UserPageExport {
  id: string;
  title: string;
  type: string;
  content: string;
  driveId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserMessageExport {
  id: string;
  source: 'ai_chat' | 'channel' | 'conversation' | 'direct_message';
  content: string;
  direction?: 'sent' | 'received';
  role?: string;
  pageId?: string;
  conversationId?: string;
  isActive?: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  /** Assistant-row lifecycle state ('ai_chat'/'conversation' sources only) — explains an
   * empty-content row as a still-streaming or interrupted placeholder rather than data loss. */
  status?: 'streaming' | 'complete' | 'interrupted';
}

export interface UserFileExport {
  id: string;
  driveId: string | null;
  sizeBytes: number;
  mimeType: string | null;
  storagePath: string | null;
  createdAt: Date;
}

export interface UserActivityExport {
  id: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  timestamp: Date;
  metadata: Record<string, unknown> | null;
}

// Excludes errorStack/ip/userAgent/sessionId/requestId/metadata — internal
// diagnostic and network telemetry, not data about the subject's own activity.
export interface UserSystemLogExport {
  id: string;
  timestamp: Date;
  level: string;
  message: string;
  category: string | null;
  endpoint: string | null;
  method: string | null;
  duration: number | null;
}

// Excludes ip/userAgent/sessionId/requestId/error/cache fields — internal
// diagnostic and network telemetry, not data about the subject's own activity.
export interface UserApiMetricExport {
  id: string;
  timestamp: Date;
  endpoint: string;
  method: string;
  statusCode: number;
  duration: number;
  requestSize: number | null;
  responseSize: number | null;
}

// Excludes stack/ip/userAgent/sessionId/requestId/metadata/resolvedBy —
// internal diagnostic telemetry and internal admin references, not data
// about the subject's own activity.
export interface UserErrorLogExport {
  id: string;
  timestamp: Date;
  name: string;
  message: string;
  endpoint: string | null;
  method: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  resolved: boolean | null;
}

export interface UserAiUsageExport {
  id: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  timestamp: Date;
}

export interface UserTaskExport {
  listId: string;
  listTitle: string;
  items: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    createdAt: Date;
  }>;
}

export interface UserSessionExport {
  id: string;
  type: string;
  deviceId: string | null;
  scopes: string[];
  createdByIp: string | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
}

export interface UserNotificationExport {
  id: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: Date;
  readAt: Date | null;
}

export interface UserDisplayPreferenceExport {
  preferenceType: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface UserPersonalizationExport {
  bio: string | null;
  writingStyle: string | null;
  rules: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One PTY the subject opened inside a workspace.
 *
 * `spriteExecId` is deliberately absent: it names an exec session on a VM in
 * OUR fleet, which is infrastructure identity rather than data about the
 * subject — the same posture the log collectors take toward
 * `sessionId`/`requestId`. `coldTail` IS carried: it is the subject's own
 * terminal scrollback, i.e. their work.
 */
export interface UserAgentWorkspaceShellExport {
  id: string;
  name: string;
  agentType: string;
  command: string | null;
  /** Tail of the last dead incarnation's scrollback — the subject's own terminal output. */
  coldTail: string | null;
  coldTailAt: Date | null;
  /** Distinguishes "was silent" from "output overflowed the ring and left an empty tail". */
  coldTailHasOutput: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A working context (`agent_workspaces`) — the drive-level workspace that owns
 * one sandbox and hosts the subject's conversations and shells.
 *
 * Excludes the whole Sprite identity block (`spriteKey`, `sandboxId`,
 * `spriteInstanceId`, `egressPolicyToken`, `teardownRequestedAt`,
 * `spriteTornDownAt`) and the storage-billing block (`storageLastBilledAt`,
 * `storageMeasuredBytes`, `storageMeasuredAt`): every one of them describes a
 * VM in OUR fleet and our accounting against it, not the subject's own
 * activity. Same exclusion set, for the same reason, as the tenant migration's
 * `AGENT_WORKSPACE_SPRITE_EXCLUSIONS`.
 */
export interface UserAgentWorkspaceExport {
  id: string;
  /**
   * `owner` — the subject's own workspace, carried whole.
   *
   * `participant` — a workspace someone ELSE owns, in which the subject ran
   * shells of their own. The shells are the subject's data and travel; the
   * workspace's own descriptive fields (`name`, `driveId`, its lifecycle
   * timestamps) describe the OWNER's working context and are withheld under
   * Art 15(4).
   */
  role: 'owner' | 'participant';
  driveId: string | null;
  name: string | null;
  lastActiveAt: Date | null;
  endedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  shells: UserAgentWorkspaceShellExport[];
}

/**
 * A generation's checkpointed stream state (`ai_stream_sessions`).
 *
 * `parts` is the reason this category exists: it is a periodic snapshot of the
 * generated `UIMessagePart[]` buffer — message CONTENT — and it is the only
 * record of a generation that was interrupted before its assistant row was
 * materialized.
 *
 * Excludes `channelId`, `browserSessionId`, `streamId`, `rawPartsCount`,
 * `lastHeartbeatAt` and `abortRequestedAt`: multicast routing keys, client
 * session telemetry, replay bookkeeping and liveness plumbing — the same
 * category of internal transport detail the log collectors already strip.
 * `displayName` is excluded too: it is the subject's own name, already carried
 * verbatim by `profile`.
 */
export interface UserStreamStateExport {
  messageId: string;
  conversationId: string;
  status: 'streaming' | 'complete' | 'aborted';
  /** Checkpointed generation content. */
  parts: unknown[];
  startedAt: Date;
  completedAt: Date | null;
}

export interface AllUserData {
  profile: UserProfileExport;
  drives: UserDriveExport[];
  pages: UserPageExport[];
  messages: UserMessageExport[];
  files: UserFileExport[];
  activity: UserActivityExport[];
  systemLogs: UserSystemLogExport[];
  apiMetrics: UserApiMetricExport[];
  errorLogs: UserErrorLogExport[];
  aiUsage: UserAiUsageExport[];
  tasks: UserTaskExport[];
  sessions: UserSessionExport[];
  notifications: UserNotificationExport[];
  displayPreferences: UserDisplayPreferenceExport[];
  personalization: UserPersonalizationExport | null;
  agentWorkspaces: UserAgentWorkspaceExport[];
  streamState: UserStreamStateExport[];
}

export async function collectUserProfile(database: DB, userId: string): Promise<UserProfileExport | null> {
  const result = await database
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      timezone: users.timezone,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Decrypt PII at the edge so the export contains plaintext email/name.
  return result[0] ? decryptUserRow(result[0]) : null;
}

export async function collectUserDrives(database: DB, userId: string): Promise<UserDriveExport[]> {
  // Owned drives
  const ownedDrives = await database
    .select({
      id: drives.id,
      name: drives.name,
      slug: drives.slug,
      createdAt: drives.createdAt,
    })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  const owned: UserDriveExport[] = ownedDrives.map(d => ({
    ...d,
    role: 'OWNER' as const,
  }));

  // Member drives
  const memberDrives = await database
    .select({
      id: drives.id,
      name: drives.name,
      slug: drives.slug,
      role: driveMembers.role,
      createdAt: drives.createdAt,
    })
    .from(driveMembers)
    .innerJoin(drives, eq(driveMembers.driveId, drives.id))
    .where(eq(driveMembers.userId, userId));

  const members: UserDriveExport[] = memberDrives.map(d => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    role: d.role,
    createdAt: d.createdAt,
  }));

  // Deduplicate (owner is also a member)
  const seen = new Set(owned.map(d => d.id));
  const unique = [...owned];
  for (const m of members) {
    if (!seen.has(m.id)) {
      unique.push(m);
      seen.add(m.id);
    }
  }
  return unique;
}

export async function collectUserPages(
  database: DB,
  userId: string,
  preloadedDriveIds?: string[],
): Promise<UserPageExport[]> {
  const driveIds = preloadedDriveIds ?? (await collectUserDrives(database, userId)).map(d => d.id);

  if (driveIds.length === 0) return [];

  return database
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      content: pages.content,
      driveId: pages.driveId,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(inArray(pages.driveId, driveIds));
}

export async function collectUserMessages(database: DB, userId: string): Promise<UserMessageExport[]> {
  const result: UserMessageExport[] = [];

  // Channel messages
  const channelMsgs = await database
    .select({
      id: channelMessages.id,
      content: channelMessages.content,
      pageId: channelMessages.pageId,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(eq(channelMessages.userId, userId));

  for (const msg of channelMsgs) {
    result.push({
      id: msg.id,
      source: 'channel',
      content: msg.content,
      pageId: msg.pageId,
      createdAt: msg.createdAt,
    });
  }

  /**
   * Chat messages — one table, every kind of thread (epic "Agent-Session
   * Single Source of Truth", Phase 4 / D6).
   *
   * ── Why the predicate is not just `messages.userId = :subject` ──────────
   * `userId` is the HUMAN author and is NULL for every agent/system-authored
   * row (page-chat assistant replies, `/help` answers, consult and worker
   * dispatches; `sourceAgentId` names the agent when known). Filtering on
   * `userId` alone exported the subject's questions and dropped every answer
   * inside their own page chats — while the same answer in a GLOBAL
   * conversation WAS exported, because the global writer stamps the owner's
   * id on assistant rows. That asymmetry is an Art 15 completeness gap, and
   * unification made it uniform rather than creating it.
   *
   * So the export is the union of:
   *   1. rows the subject AUTHORED (`messages.userId = :subject`) — wherever
   *      they live, including a conversation someone else owns (a shared
   *      page conversation accepts messages from any member who can access
   *      it), and
   *   2. rows with NO human author that sit in a conversation the subject
   *      OWNS — the agent/system side of the subject's own threads.
   *
   * It deliberately stops there. Rows authored by ANOTHER human inside the
   * subject's shared conversation stay out: they are that person's data, and
   * Art 15(4) says a subject's access right must not adversely affect the
   * rights of others. `conversations.userId` alone would have swept them in
   * (multi-author legacy conversations exist — 0249's orphan synthesis logs
   * how many it found, "earliest human author wins").
   *
   * The join is INNER by design: `messages.conversationId` carries a real,
   * VALIDATED FK to `conversations`, so a message with no conversation row
   * cannot exist and the join cannot silently drop one.
   */
  const convMsgs = await database
    .select({
      id: messages.id,
      content: messages.content,
      role: messages.role,
      conversationId: messages.conversationId,
      createdAt: messages.createdAt,
      status: messages.status,
      conversationType: conversations.type,
      conversationContextId: conversations.contextId,
      conversationAgentPageId: conversations.agentPageId,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      or(
        eq(messages.userId, userId),
        and(isNull(messages.userId), eq(conversations.userId, userId)),
      )
    );

  for (const msg of convMsgs) {
    const isGlobal = msg.conversationType === 'global';
    result.push({
      id: msg.id,
      // The export vocabulary predates the merge and is kept: a page/client
      // thread is still reported as 'ai_chat', a global thread as
      // 'conversation'. One physical table, two documented sources.
      source: isGlobal ? 'conversation' : 'ai_chat',
      content: msg.content,
      role: msg.role,
      // The page comes from the CONVERSATION — there is no per-row page
      // column. Each kind names it in its own place: `type='page'` in
      // `contextId`, `type='client'` in `agentPageId` (its `contextId` is a
      // DRIVE). Anything else — a global thread, or an API thread that never
      // ran a completion — reports no pageId rather than a wrong one.
      ...(() => {
        const derived =
          msg.conversationType === 'page' ? msg.conversationContextId
          : msg.conversationType === 'client' ? msg.conversationAgentPageId
          : null;
        return derived ? { pageId: derived } : {};
      })(),
      conversationId: msg.conversationId,
      createdAt: msg.createdAt,
      status: msg.status,
    });
  }

  // Sent direct messages
  const sentDms = await database
    .select({
      id: directMessages.id,
      content: directMessages.content,
      conversationId: directMessages.conversationId,
      isActive: directMessages.isActive,
      deletedAt: directMessages.deletedAt,
      createdAt: directMessages.createdAt,
    })
    .from(directMessages)
    .where(eq(directMessages.senderId, userId));

  for (const msg of sentDms) {
    result.push({
      id: msg.id,
      source: 'direct_message',
      content: msg.content,
      direction: 'sent',
      conversationId: msg.conversationId,
      isActive: msg.isActive,
      deletedAt: msg.deletedAt,
      createdAt: msg.createdAt,
    });
  }

  // Received direct messages — find conversations where user is a participant but not the sender
  const userDmConversations = await database
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(
      or(
        eq(dmConversations.participant1Id, userId),
        eq(dmConversations.participant2Id, userId),
      )
    );

  if (userDmConversations.length > 0) {
    const conversationIds = userDmConversations.map(c => c.id);
    const receivedDms = await database
      .select({
        id: directMessages.id,
        content: directMessages.content,
        conversationId: directMessages.conversationId,
        isActive: directMessages.isActive,
        deletedAt: directMessages.deletedAt,
        createdAt: directMessages.createdAt,
      })
      .from(directMessages)
      .where(
        and(
          inArray(directMessages.conversationId, conversationIds),
          ne(directMessages.senderId, userId),
        )
      );

    for (const msg of receivedDms) {
      result.push({
        id: msg.id,
        source: 'direct_message',
        content: msg.content,
        direction: 'received',
        conversationId: msg.conversationId,
        isActive: msg.isActive,
        deletedAt: msg.deletedAt,
        createdAt: msg.createdAt,
      });
    }
  }

  return result;
}

export async function collectUserFiles(database: DB, userId: string): Promise<UserFileExport[]> {
  const result = await database
    .select({
      id: files.id,
      driveId: files.driveId,
      sizeBytes: files.sizeBytes,
      mimeType: files.mimeType,
      storagePath: files.storagePath,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(eq(files.createdBy, userId));

  return result;
}

export async function collectUserActivity(database: DB, userId: string): Promise<UserActivityExport[]> {
  const result = await database
    .select({
      id: activityLogs.id,
      operation: activityLogs.operation,
      resourceType: activityLogs.resourceType,
      resourceId: activityLogs.resourceId,
      timestamp: activityLogs.timestamp,
      metadata: activityLogs.metadata,
    })
    .from(activityLogs)
    .where(eq(activityLogs.userId, userId));

  return result;
}

export async function collectUserSystemLogs(database: DB, userId: string): Promise<UserSystemLogExport[]> {
  const result = await database
    .select({
      id: systemLogs.id,
      timestamp: systemLogs.timestamp,
      level: systemLogs.level,
      message: systemLogs.message,
      category: systemLogs.category,
      endpoint: systemLogs.endpoint,
      method: systemLogs.method,
      duration: systemLogs.duration,
    })
    .from(systemLogs)
    .where(eq(systemLogs.userId, userId));

  const client = clickHouseClientOrNull();
  if (!client) return result;
  return [...result, ...(await collectChUserSystemLogs(client, userId))];
}

export async function collectUserApiMetrics(database: DB, userId: string): Promise<UserApiMetricExport[]> {
  const result = await database
    .select({
      id: apiMetrics.id,
      timestamp: apiMetrics.timestamp,
      endpoint: apiMetrics.endpoint,
      method: apiMetrics.method,
      statusCode: apiMetrics.statusCode,
      duration: apiMetrics.duration,
      requestSize: apiMetrics.requestSize,
      responseSize: apiMetrics.responseSize,
    })
    .from(apiMetrics)
    .where(eq(apiMetrics.userId, userId));

  const client = clickHouseClientOrNull();
  if (!client) return result;
  return [...result, ...(await collectChUserApiMetrics(client, userId))];
}

export async function collectUserErrorLogs(database: DB, userId: string): Promise<UserErrorLogExport[]> {
  const result = await database
    .select({
      id: errorLogs.id,
      timestamp: errorLogs.timestamp,
      name: errorLogs.name,
      message: errorLogs.message,
      endpoint: errorLogs.endpoint,
      method: errorLogs.method,
      file: errorLogs.file,
      line: errorLogs.line,
      column: errorLogs.column,
      resolved: errorLogs.resolved,
    })
    .from(errorLogs)
    .where(eq(errorLogs.userId, userId));

  const client = clickHouseClientOrNull();
  if (!client) return result;

  const chRows = await collectChUserErrorLogs(client, userId);
  if (chRows.length === 0) return result;

  // CH rows carry no resolution state — the resolved flag lives in the
  // error_resolutions mini-table in main PG (cross-store two-step, leaf 3).
  const resolutionRows = await database
    .select({ errorId: errorResolutions.errorId, resolved: errorResolutions.resolved })
    .from(errorResolutions)
    .where(inArray(errorResolutions.errorId, chRows.map((r) => r.id)));
  const resolvedById = new Map(resolutionRows.map((r) => [r.errorId, r.resolved]));

  return [
    ...result,
    // No workflow row = never resolved (false, matching the PG column default).
    ...chRows.map((r) => ({ ...r, resolved: resolvedById.get(r.id) ?? false })),
  ];
}

export async function collectUserAiUsage(database: DB, userId: string): Promise<UserAiUsageExport[]> {
  const result = await database
    .select({
      id: aiUsageLogs.id,
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      inputTokens: aiUsageLogs.inputTokens,
      outputTokens: aiUsageLogs.outputTokens,
      cost: aiUsageLogs.cost,
      timestamp: aiUsageLogs.timestamp,
    })
    .from(aiUsageLogs)
    .where(eq(aiUsageLogs.userId, userId));

  return result;
}

export async function collectUserTasks(database: DB, userId: string): Promise<UserTaskExport[]> {
  const lists = await database
    .select({
      id: taskLists.id,
      pageId: taskLists.pageId,
      title: taskLists.title,
    })
    .from(taskLists)
    .where(eq(taskLists.userId, userId));

  if (lists.length === 0) return [];

  const listPageIds = lists.map(l => l.pageId).filter((id): id is string => id != null);

  if (listPageIds.length === 0) {
    return lists.map(list => ({ listId: list.id, listTitle: list.title, items: [] }));
  }

  const allItems = await database
    .select({
      id: taskItems.id,
      title: pages.title,
      status: taskItems.status,
      priority: taskItems.priority,
      taskListPageId: pages.parentId,
      createdAt: taskItems.createdAt,
    })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(
      inArray(pages.parentId, listPageIds),
      eq(pages.isTrashed, false),
    ));

  const itemsByListPageId = new Map<string, typeof allItems>();
  for (const item of allItems) {
    if (!item.taskListPageId) continue;
    const existing = itemsByListPageId.get(item.taskListPageId) ?? [];
    existing.push(item);
    itemsByListPageId.set(item.taskListPageId, existing);
  }

  return lists.map(list => ({
    listId: list.id,
    listTitle: list.title,
    items: (itemsByListPageId.get(list.pageId ?? '') ?? []).map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      createdAt: item.createdAt,
    })),
  }));
}

export async function collectUserSessions(database: DB, userId: string): Promise<UserSessionExport[]> {
  return database
    .select({
      id: sessions.id,
      type: sessions.type,
      deviceId: sessions.deviceId,
      scopes: sessions.scopes,
      createdByIp: sessions.createdByIp,
      lastUsedAt: sessions.lastUsedAt,
      lastUsedIp: sessions.lastUsedIp,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      revokedReason: sessions.revokedReason,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

export async function collectUserNotifications(database: DB, userId: string): Promise<UserNotificationExport[]> {
  const result = await database
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      message: notifications.message,
      metadata: notifications.metadata,
      isRead: notifications.isRead,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  return result.map(n => ({
    ...n,
    metadata: n.metadata as Record<string, unknown> | null,
  }));
}

export async function collectUserDisplayPreferences(database: DB, userId: string): Promise<UserDisplayPreferenceExport[]> {
  return database
    .select({
      preferenceType: displayPreferences.preferenceType,
      enabled: displayPreferences.enabled,
      updatedAt: displayPreferences.updatedAt,
    })
    .from(displayPreferences)
    .where(eq(displayPreferences.userId, userId));
}

export async function collectUserPersonalization(database: DB, userId: string): Promise<UserPersonalizationExport | null> {
  const result = await database
    .select({
      bio: userPersonalization.bio,
      writingStyle: userPersonalization.writingStyle,
      rules: userPersonalization.rules,
      enabled: userPersonalization.enabled,
      createdAt: userPersonalization.createdAt,
      updatedAt: userPersonalization.updatedAt,
    })
    .from(userPersonalization)
    .where(eq(userPersonalization.userId, userId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * The subject's WORKING CONTEXTS and the shells inside them.
 *
 * ── Why this collector exists ────────────────────────────────────────────────
 * The epic "Agent-Session Single Source of Truth" moved a large amount of the
 * subject's actual work into `agent_workspaces` / `agent_workspace_shells`.
 * Nothing collected either one, so a subject access request answered LESS after
 * the epic than before it, in a product where the workspace and its shells ARE
 * the work. The asymmetry was sharpest against erasure: `purge-stream-state`
 * and the `users` cascade already REACH this content on an Art 17 request. We
 * were deleting on demand what we would not disclose on demand.
 *
 * ── The Art 15(4) boundary ──────────────────────────────────────────────────
 * Exactly the rule `collectUserMessages` settled on: rows the subject
 * AUTHORED, wherever they live — never another person's rows just because they
 * sit in a container the subject owns.
 *
 *   - Workspaces: `ownerId = :subject`.
 *   - Shells: `ownerId = :subject`. A shell's `ownerId` is the ACTING user
 *     (`spawnSessionShell` takes it from the caller), which in a SHARED
 *     workspace is not necessarily the workspace's owner. So the subject's own
 *     shell inside someone else's workspace travels — as a `participant` entry
 *     carrying the shells and nothing descriptive about the other person's
 *     workspace — and another member's shell inside the SUBJECT's workspace
 *     does NOT. `conversations.workspaceId` binds the threads, which
 *     `collectUserMessages` already exports under its own boundary.
 */
export async function collectUserAgentWorkspaces(
  database: DB,
  userId: string,
): Promise<UserAgentWorkspaceExport[]> {
  const ownedWorkspaces = await database
    .select({
      id: agentWorkspaces.id,
      driveId: agentWorkspaces.driveId,
      name: agentWorkspaces.name,
      lastActiveAt: agentWorkspaces.lastActiveAt,
      endedAt: agentWorkspaces.endedAt,
      createdAt: agentWorkspaces.createdAt,
      updatedAt: agentWorkspaces.updatedAt,
    })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.ownerId, userId));

  const ownedShells = await database
    .select({
      id: agentWorkspaceShells.id,
      workspaceId: agentWorkspaceShells.workspaceId,
      name: agentWorkspaceShells.name,
      agentType: agentWorkspaceShells.agentType,
      command: agentWorkspaceShells.command,
      coldTail: agentWorkspaceShells.coldTail,
      coldTailAt: agentWorkspaceShells.coldTailAt,
      coldTailHasOutput: agentWorkspaceShells.coldTailHasOutput,
      createdAt: agentWorkspaceShells.createdAt,
      updatedAt: agentWorkspaceShells.updatedAt,
    })
    .from(agentWorkspaceShells)
    .where(eq(agentWorkspaceShells.ownerId, userId));

  const shellsByWorkspace = new Map<string, UserAgentWorkspaceShellExport[]>();
  for (const shell of ownedShells) {
    const { workspaceId, ...rest } = shell;
    const bucket = shellsByWorkspace.get(workspaceId) ?? [];
    bucket.push(rest);
    shellsByWorkspace.set(workspaceId, bucket);
  }

  const result: UserAgentWorkspaceExport[] = ownedWorkspaces.map((workspace) => ({
    ...workspace,
    role: 'owner' as const,
    shells: shellsByWorkspace.get(workspace.id) ?? [],
  }));

  // Subject-owned shells that live in somebody else's workspace. The shells are
  // the subject's data and must not be dropped; the host workspace's own
  // fields are the OWNER's and are withheld (Art 15(4)).
  const ownedIds = new Set(ownedWorkspaces.map((w) => w.id));
  for (const [workspaceId, shells] of shellsByWorkspace) {
    if (ownedIds.has(workspaceId)) continue;
    result.push({
      id: workspaceId,
      role: 'participant',
      driveId: null,
      name: null,
      lastActiveAt: null,
      endedAt: null,
      createdAt: null,
      updatedAt: null,
      shells,
    });
  }

  return result;
}

/**
 * Checkpointed generation state (`ai_stream_sessions`).
 *
 * ── Why the predicate is not just `ai_stream_sessions.user_id = :subject` ────
 * Same shape as `collectUserMessages`, for the same reason. `user_id` is the
 * human who triggered the generation, and the union is:
 *
 *   1. rows the subject TRIGGERED (`user_id = :subject`) — wherever they live,
 *      including a shared conversation someone else owns; and
 *   2. rows with NO human trigger — a `user_id` that matches no `users` row,
 *      i.e. a service/agent actor such as a dispatched worker — that sit in a
 *      conversation the subject OWNS.
 *
 * Leg 2 is the same Art 15 hole the epic already closed for `messages`: the
 * agent side of the subject's own thread must not vanish from their export
 * merely because no person authored it. It is expressed as "no matching `users`
 * row" rather than "NULL" because this column is NOT NULL — an agent actor
 * carries an id that simply is not a person's.
 *
 * It stops there. A row triggered by ANOTHER HUMAN inside the subject's shared
 * conversation stays out: `parts` is that person's generated content, and
 * Art 15(4) forbids letting one subject's access right override another's.
 */
export async function collectUserStreamState(
  database: DB,
  userId: string,
): Promise<UserStreamStateExport[]> {
  const rows = await database
    .select({
      messageId: aiStreamSessions.messageId,
      conversationId: aiStreamSessions.conversationId,
      status: aiStreamSessions.status,
      parts: aiStreamSessions.parts,
      startedAt: aiStreamSessions.startedAt,
      completedAt: aiStreamSessions.completedAt,
    })
    .from(aiStreamSessions)
    .innerJoin(conversations, eq(aiStreamSessions.conversationId, conversations.id))
    .leftJoin(users, eq(users.id, aiStreamSessions.userId))
    .where(
      or(
        eq(aiStreamSessions.userId, userId),
        and(isNull(users.id), eq(conversations.userId, userId)),
      ),
    );

  return rows.map((row) => ({ ...row, parts: row.parts ?? [] }));
}

export async function collectAllUserData(database: DB, userId: string): Promise<AllUserData | null> {
  const profile = await collectUserProfile(database, userId);
  if (!profile) return null;

  const userDrives = await collectUserDrives(database, userId);
  const driveIds = userDrives.map(d => d.id);

  // Positional: this destructuring order must exactly match the Promise.all array
  // order below (each collector returns a differently-shaped array, so TypeScript
  // cannot catch a reorder/insert mismatch here).
  const [userPages, userMessages, userFiles, activity, userSystemLogs, userApiMetrics, userErrorLogs, aiUsage, tasks, userSessions, userNotifications, userDisplayPreferences, userPersonalizationData, userAgentWorkspaces, userStreamState] = await Promise.all([
    collectUserPages(database, userId, driveIds),
    collectUserMessages(database, userId),
    collectUserFiles(database, userId),
    collectUserActivity(database, userId),
    collectUserSystemLogs(database, userId),
    collectUserApiMetrics(database, userId),
    collectUserErrorLogs(database, userId),
    collectUserAiUsage(database, userId),
    collectUserTasks(database, userId),
    collectUserSessions(database, userId),
    collectUserNotifications(database, userId),
    collectUserDisplayPreferences(database, userId),
    collectUserPersonalization(database, userId),
    collectUserAgentWorkspaces(database, userId),
    collectUserStreamState(database, userId),
  ]);

  return {
    profile,
    drives: userDrives,
    pages: userPages,
    messages: userMessages,
    files: userFiles,
    activity,
    systemLogs: userSystemLogs,
    apiMetrics: userApiMetrics,
    errorLogs: userErrorLogs,
    aiUsage,
    tasks,
    sessions: userSessions,
    notifications: userNotifications,
    displayPreferences: userDisplayPreferences,
    personalization: userPersonalizationData,
    agentWorkspaces: userAgentWorkspaces,
    streamState: userStreamState,
  };
}
