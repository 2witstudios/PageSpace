import { pgTable, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

export const messageDrafts = pgTable('message_drafts', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contextKey: text('contextKey').notNull(),
  content: text('content').notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
}, (t) => ({
  uniq: uniqueIndex('message_drafts_user_context_key').on(t.userId, t.contextKey),
  expiresIdx: index('message_drafts_expires_at_idx').on(t.expiresAt),
}));

export const messageDraftsRelations = relations(messageDrafts, ({ one }) => ({
  user: one(users, {
    fields: [messageDrafts.userId],
    references: [users.id],
  }),
}));

export type MessageDraft = typeof messageDrafts.$inferSelect;
export type NewMessageDraft = typeof messageDrafts.$inferInsert;
