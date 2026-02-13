/**
 * Shared row interfaces for raw SQL queries in messaging routes.
 *
 * These mirror the column aliases returned by CTE-based queries in
 * /api/messages/threads, /api/messages/conversations, and /api/inbox.
 * Keeping them here avoids duplicating the same interface in every route.
 */

/** Row returned by the DM conversation + user join query */
export interface ConversationRow extends Record<string, unknown> {
  id: string;
  participant1Id: string;
  participant2Id: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  participant1LastRead: string | null;
  participant2LastRead: string | null;
  createdAt: string;
  last_read: string | null;
  other_user_id: string;
  other_user_name: string;
  other_user_email: string;
  other_user_image: string | null;
  other_user_username: string | null;
  other_user_display_name: string | null;
  other_user_avatar_url: string | null;
  unread_count: string;
}

/** Row returned by the channel listing queries */
export interface ChannelRow extends Record<string, unknown> {
  id: string;
  name: string;
  drive_id: string;
  drive_name: string;
  last_message: string | null;
  last_message_at: string | null;
  sender_name: string | null;
  unread_count: string;
}

/** Row returned by the channel listing in threads route (different column set) */
export interface ChannelThreadRow extends Record<string, unknown> {
  id: string;
  title: string;
  driveId: string;
  drive_name: string;
  updatedAt: string;
  last_message: string | null;
  last_message_at: string | null;
}

/** Row returned by the DM listing in inbox route */
export interface DMRow extends Record<string, unknown> {
  id: string;
  last_message_at: string | null;
  last_message: string | null;
  other_user_name: string;
  other_user_display_name: string | null;
  other_user_avatar_url: string | null;
  unread_count: string;
}

/** Row returned by the single-conversation detail query */
export interface ConversationDetailRow extends Record<string, unknown> {
  id: string;
  participant1Id: string;
  participant2Id: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  other_user_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_image: string | null;
  user_username: string | null;
  user_display_name: string | null;
  user_avatar_url: string | null;
}
