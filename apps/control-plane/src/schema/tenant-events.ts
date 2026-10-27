import { pgTable, text, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { tenants } from './tenants'

export const tenantEvents = pgTable('tenant_events', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdIdx: index('tenant_events_tenant_id_idx').on(table.tenantId),
  createdAtIdx: index('tenant_events_created_at_idx').on(table.createdAt),
}))
