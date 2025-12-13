import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
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
  // Schedule tracking for pending plan changes (downgrades)
  stripeScheduleId: text('stripeScheduleId'),
  scheduledPriceId: text('scheduledPriceId'),
  scheduledChangeDate: timestamp('scheduledChangeDate', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userIdx: index('subscriptions_user_id_idx').on(table.userId),
    stripeSubscriptionIdx: index('subscriptions_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
    stripeScheduleIdx: index('subscriptions_stripe_schedule_id_idx').on(table.stripeScheduleId),
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

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));