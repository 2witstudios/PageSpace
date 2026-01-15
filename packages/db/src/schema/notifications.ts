import { pgTable, text, timestamp, boolean, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';
import { drives } from './core';
import { createId } from '@paralleldrive/cuid2';

export const notificationType = pgEnum('NotificationType', [
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'PERMISSION_UPDATED',
  'PAGE_SHARED',
  'DRIVE_INVITED',
  'DRIVE_JOINED',
  'DRIVE_ROLE_CHANGED',
  'CONNECTION_REQUEST',
  'CONNECTION_ACCEPTED',
  'CONNECTION_REJECTED',
  'NEW_DIRECT_MESSAGE',
  'EMAIL_VERIFICATION_REQUIRED',
  'TOS_PRIVACY_UPDATED',
  'MENTION',
  'TASK_ASSIGNED'
]);

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: notificationType('type').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  metadata: jsonb('metadata'),
  isRead: boolean('isRead').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  readAt: timestamp('readAt', { mode: 'date' }),
  
  // Optional references to related entities
  pageId: text('pageId').references(() => pages.id, { onDelete: 'cascade' }),
  driveId: text('driveId').references(() => drives.id, { onDelete: 'cascade' }),
  triggeredByUserId: text('triggeredByUserId').references(() => users.id, { onDelete: 'set null' }),
}, (table) => {
  return {
    userIdx: index('notifications_user_id_idx').on(table.userId),
    userIsReadIdx: index('notifications_user_id_is_read_idx').on(table.userId, table.isRead),
    createdAtIdx: index('notifications_created_at_idx').on(table.createdAt),
    typeIdx: index('notifications_type_idx').on(table.type),
  }
});

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
  page: one(pages, {
    fields: [notifications.pageId],
    references: [pages.id],
  }),
  drive: one(drives, {
    fields: [notifications.driveId],
    references: [drives.id],
  }),
  triggeredByUser: one(users, {
    fields: [notifications.triggeredByUserId],
    references: [users.id],
  }),
}));