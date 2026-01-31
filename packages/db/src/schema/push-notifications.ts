import { pgTable, text, timestamp, boolean, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

export const pushPlatformType = pgEnum('PushPlatformType', ['ios', 'android', 'web']);

export const pushNotificationTokens = pgTable('push_notification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // The push token from APNs (iOS), FCM (Android), or Web Push subscription
  token: text('token').notNull(),

  // Platform identification
  platform: pushPlatformType('platform').notNull(),

  // Device identification for managing multiple devices
  deviceId: text('deviceId'),
  deviceName: text('deviceName'),

  // Token state
  isActive: boolean('isActive').default(true).notNull(),

  // For web push, we need to store the full subscription object
  // Contains endpoint, keys (p256dh, auth) for Web Push API
  webPushSubscription: text('webPushSubscription'),

  // Timestamps
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
  lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),

  // Track failed delivery attempts for cleanup
  failedAttempts: text('failedAttempts').default('0'),
  lastFailedAt: timestamp('lastFailedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('push_notification_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('push_notification_tokens_token_idx').on(table.token),
    platformIdx: index('push_notification_tokens_platform_idx').on(table.platform),
    activeIdx: index('push_notification_tokens_active_idx').on(table.userId, table.isActive),
  };
});

export const pushNotificationTokensRelations = relations(pushNotificationTokens, ({ one }) => ({
  user: one(users, {
    fields: [pushNotificationTokens.userId],
    references: [users.id],
  }),
}));

// Types for external use
export type PushNotificationToken = typeof pushNotificationTokens.$inferSelect;
export type NewPushNotificationToken = typeof pushNotificationTokens.$inferInsert;
