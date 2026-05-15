import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const waitlistEntries = pgTable('waitlist_entries', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  email: text('email').unique().notNull(),
  name: text('name'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});
