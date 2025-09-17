import { pgTable, text, timestamp, integer, boolean, date, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripeSubscriptionId').unique().notNull(),
  stripePriceId: text('stripePriceId').notNull(),
  status: text('status').notNull(), // active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired
  currentPeriodStart: timestamp('currentPeriodStart', { mode: 'date' }).notNull(),
  currentPeriodEnd: timestamp('currentPeriodEnd', { mode: 'date' }).notNull(),
  cancelAtPeriodEnd: boolean('cancelAtPeriodEnd').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userIdx: index('subscriptions_user_id_idx').on(table.userId),
    stripeSubscriptionIdx: index('subscriptions_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
  }
});

export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(), // Stripe event.id as primary key for idempotency
  type: text('type').notNull(),
  processedAt: timestamp('processedAt', { mode: 'date' }).defaultNow().notNull(),
  error: text('error'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    typeIdx: index('stripe_events_type_idx').on(table.type),
    processedAtIdx: index('stripe_events_processed_at_idx').on(table.processedAt),
  }
});

export const aiUsageDaily = pgTable('ai_usage_daily', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  date: date('date').notNull(), // UTC date
  providerType: text('providerType').notNull(), // 'normal' or 'extra_thinking'
  count: integer('count').default(0).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userDateProviderUnique: unique('ai_usage_daily_user_date_provider_unique').on(table.userId, table.date, table.providerType),
    userIdx: index('ai_usage_daily_user_id_idx').on(table.userId),
    dateIdx: index('ai_usage_daily_date_idx').on(table.date),
  }
});

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const aiUsageDailyRelations = relations(aiUsageDaily, ({ one }) => ({
  user: one(users, {
    fields: [aiUsageDaily.userId],
    references: [users.id],
  }),
}));