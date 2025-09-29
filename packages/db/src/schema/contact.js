import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
export const contactSubmissions = pgTable('contact_submissions', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    name: text('name').notNull(),
    email: text('email').notNull(),
    subject: text('subject').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
    return {
        emailIdx: index('contact_submissions_email_idx').on(table.email),
        createdAtIdx: index('contact_submissions_created_at_idx').on(table.createdAt),
    };
});
//# sourceMappingURL=contact.js.map