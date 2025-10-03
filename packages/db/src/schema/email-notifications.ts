import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { notificationType } from './notifications';
import { createId } from '@paralleldrive/cuid2';

// Email notification preferences - tracks which notification types users want via email
export const emailNotificationPreferences = pgTable('email_notification_preferences', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  notificationType: notificationType('notificationType').notNull(),
  emailEnabled: boolean('emailEnabled').default(true).notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userTypeIdx: index('email_notification_preferences_user_type_idx').on(table.userId, table.notificationType),
  };
});

// Email notification log - tracks all email notification sends for debugging/analytics
export const emailNotificationLog = pgTable('email_notification_log', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  notificationId: text('notificationId'),
  notificationType: notificationType('notificationType').notNull(),
  recipientEmail: text('recipientEmail').notNull(),
  success: boolean('success').notNull(),
  errorMessage: text('errorMessage'),
  sentAt: timestamp('sentAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('email_notification_log_user_idx').on(table.userId),
    sentAtIdx: index('email_notification_log_sent_at_idx').on(table.sentAt),
    notificationIdIdx: index('email_notification_log_notification_id_idx').on(table.notificationId),
  };
});

export const emailNotificationPreferencesRelations = relations(emailNotificationPreferences, ({ one }) => ({
  user: one(users, {
    fields: [emailNotificationPreferences.userId],
    references: [users.id],
  }),
}));

export const emailNotificationLogRelations = relations(emailNotificationLog, ({ one }) => ({
  user: one(users, {
    fields: [emailNotificationLog.userId],
    references: [users.id],
  }),
}));
