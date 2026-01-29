import { pgTable, text, timestamp, index, jsonb } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { relations } from 'drizzle-orm';
import { users } from './auth';

// Type for feedback attachments stored as JSON
export interface FeedbackAttachment {
  name: string;
  type: string;
  data: string; // base64 data URL
}

export const feedbackSubmissions = pgTable('feedback_submissions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),

  // Attachments stored as JSON (base64 encoded images)
  attachments: jsonb('attachments').$type<FeedbackAttachment[]>(),

  // Auto-captured context
  pageUrl: text('page_url'),
  userAgent: text('user_agent'),
  screenSize: text('screen_size'),
  viewportSize: text('viewport_size'),
  appVersion: text('app_version'),
  consoleErrors: jsonb('console_errors').$type<string[]>(),

  // Metadata
  status: text('status').notNull().default('new'), // new, reviewed, resolved
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdIdx: index('feedback_submissions_user_id_idx').on(table.userId),
    statusIdx: index('feedback_submissions_status_idx').on(table.status),
    createdAtIdx: index('feedback_submissions_created_at_idx').on(table.createdAt),
  }
});

export const feedbackSubmissionsRelations = relations(feedbackSubmissions, ({ one }) => ({
  user: one(users, {
    fields: [feedbackSubmissions.userId],
    references: [users.id],
  }),
}));
