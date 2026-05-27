import { pgTable, text, timestamp, boolean, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { drives } from './core';
import { createId } from '@paralleldrive/cuid2';

export const zoomConnectionStatus = pgEnum('ZoomConnectionStatus', [
  'active',
  'expired',
  'error',
  'disconnected',
]);

/**
 * Stores OAuth tokens and auto-save config for the Zoom transcript integration.
 * One connection per user (unique constraint on userId).
 */
export const zoomConnections = pgTable('zoom_connections', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

  // OAuth tokens (encrypted at rest via application layer)
  accessToken: text('accessToken').notNull(),
  refreshToken: text('refreshToken'),
  tokenExpiresAt: timestamp('tokenExpiresAt', { mode: 'date', withTimezone: true }),

  // Zoom account identity — used to map incoming webhooks to a PageSpace user
  zoomUserId: text('zoomUserId').notNull(),       // from GET /users/me → id
  zoomAccountId: text('zoomAccountId').notNull(), // from GET /users/me → account_id
  zoomEmail: text('zoomEmail').notNull(),

  // Connection status
  status: zoomConnectionStatus('status').default('active').notNull(),

  // Auto-save target
  targetDriveId: text('targetDriveId').references(() => drives.id, { onDelete: 'set null' }),
  targetFolderId: text('targetFolderId'), // page ID of target folder; soft ref (no FK)

  // null = v1 (read-only scopes), 'v2' = full scopes including meeting:write
  scopeVersion: text('scopeVersion'),

  // Per-user content options (all default on per user research)
  includeAiSummary: boolean('includeAiSummary').default(true).notNull(),
  includeActionItems: boolean('includeActionItems').default(true).notNull(),
  includeTranscript: boolean('includeTranscript').default(true).notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userIdx: index('zoom_connections_user_id_idx').on(table.userId),
    statusIdx: index('zoom_connections_status_idx').on(table.status),
    accountIdx: index('zoom_connections_account_id_idx').on(table.zoomAccountId),
    targetDriveIdx: index('zoom_connections_target_drive_id_idx').on(table.targetDriveId),
  };
});

export const zoomConnectionsRelations = relations(zoomConnections, ({ one }) => ({
  user: one(users, {
    fields: [zoomConnections.userId],
    references: [users.id],
  }),
  targetDrive: one(drives, {
    fields: [zoomConnections.targetDriveId],
    references: [drives.id],
  }),
}));

export type ZoomConnection = typeof zoomConnections.$inferSelect;
export type NewZoomConnection = typeof zoomConnections.$inferInsert;
