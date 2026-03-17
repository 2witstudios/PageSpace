import { pgTable, uuid, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { tenants } from './tenants'

export const tenantEvents = pgTable('tenant_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
