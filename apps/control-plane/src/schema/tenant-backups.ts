import { pgTable, text, varchar, timestamp, bigint, pgEnum, index } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { tenants } from './tenants'

export const backupStatusEnum = pgEnum('backup_status', [
  'pending',
  'running',
  'completed',
  'failed',
])

export const tenantBackups = pgTable('tenant_backups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  backupPath: varchar('backup_path', { length: 1024 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  status: backupStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  tenantIdIdx: index('tenant_backups_tenant_id_idx').on(table.tenantId),
}))
