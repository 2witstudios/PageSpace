import { pgTable, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';

// Tracks when users last viewed pages - used for "changed since last seen" indicators
export const userPageViews = pgTable('user_page_views', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  viewedAt: timestamp('viewedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.userId, table.pageId] }),
    userIdx: index('user_page_views_user_id_idx').on(table.userId),
    pageIdx: index('user_page_views_page_id_idx').on(table.pageId),
    // Composite index for efficient lookup of user's page views
    userPageIdx: index('user_page_views_user_page_idx').on(table.userId, table.pageId),
  }
});

export const userPageViewsRelations = relations(userPageViews, ({ one }) => ({
  user: one(users, {
    fields: [userPageViews.userId],
    references: [users.id],
  }),
  page: one(pages, {
    fields: [userPageViews.pageId],
    references: [pages.id],
  }),
}));
