import { pgTable, text, timestamp, bigint, integer, index, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { drives, pages } from './core';
import { users } from './auth';
import { dmConversations } from './social';

export interface AttachmentMeta {
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

export const files = pgTable('files', {
  id: text('id').primaryKey(),
  driveId: text('driveId').references(() => drives.id, { onDelete: 'cascade' }),
  sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull(),
  mimeType: text('mimeType'),
  storagePath: text('storagePath'),
  checksumVersion: integer('checksumVersion').default(1).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  lastAccessedAt: timestamp('lastAccessedAt', { mode: 'date' }),
}, (table) => ({
  driveIdx: index('files_drive_id_idx').on(table.driveId),
}));

export const filePages = pgTable('file_pages', {
  fileId: text('fileId')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  pageId: text('pageId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  linkedBy: text('linkedBy').references(() => users.id, { onDelete: 'set null' }),
  linkedAt: timestamp('linkedAt', { mode: 'date' }).defaultNow().notNull(),
  linkSource: text('linkSource'),
}, (table) => ({
  pk: primaryKey({ columns: [table.fileId, table.pageId] }),
  fileIdx: index('file_pages_file_id_idx').on(table.fileId),
  pageIdx: index('file_pages_page_id_idx').on(table.pageId),
}));

export const fileConversations = pgTable('file_conversations', {
  fileId: text('fileId')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  conversationId: text('conversationId')
    .notNull()
    .references(() => dmConversations.id, { onDelete: 'cascade' }),
  linkedBy: text('linkedBy').references(() => users.id, { onDelete: 'set null' }),
  linkedAt: timestamp('linkedAt', { mode: 'date' }).defaultNow().notNull(),
  linkSource: text('linkSource'),
}, (table) => ({
  pk: primaryKey({ columns: [table.fileId, table.conversationId] }),
  fileIdx: index('file_conversations_file_id_idx').on(table.fileId),
  conversationIdx: index('file_conversations_conversation_id_idx').on(table.conversationId),
}));

/**
 * One row per presign-reserved in-flight upload (#2154). Replaces the old
 * users.activeUploads counter: the per-user concurrent-upload limit is derived
 * by counting this user's rows with expiresAt > now(), so a process restart
 * between presign and complete can never leak a permanent +1 — an orphaned row
 * simply expires. Rows are deleted at complete/cancel/stale-sweep; expired
 * leftovers are reaped by the sweep-expired cron.
 */
export const pendingUploads = pgTable('pending_uploads', {
  /** The semaphore slot id (jobId) issued at presign. */
  id: text('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  fileSize: bigint('fileSize', { mode: 'number' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
}, (table) => ({
  // Live-count query: WHERE userId = ? AND expiresAt > now()
  userExpiryIdx: index('pending_uploads_user_expires_idx').on(table.userId, table.expiresAt),
  // TTL sweep: DELETE WHERE expiresAt < now()
  expiryIdx: index('pending_uploads_expires_idx').on(table.expiresAt),
}));

export const pendingUploadsRelations = relations(pendingUploads, ({ one }) => ({
  user: one(users, {
    fields: [pendingUploads.userId],
    references: [users.id],
  }),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  drive: one(drives, {
    fields: [files.driveId],
    references: [drives.id],
  }),
  creator: one(users, {
    fields: [files.createdBy],
    references: [users.id],
  }),
  filePages: many(filePages),
  fileConversations: many(fileConversations),
}));

export const filePagesRelations = relations(filePages, ({ one }) => ({
  file: one(files, {
    fields: [filePages.fileId],
    references: [files.id],
  }),
  page: one(pages, {
    fields: [filePages.pageId],
    references: [pages.id],
  }),
  linker: one(users, {
    fields: [filePages.linkedBy],
    references: [users.id],
  }),
}));

export const fileConversationsRelations = relations(fileConversations, ({ one }) => ({
  file: one(files, {
    fields: [fileConversations.fileId],
    references: [files.id],
  }),
  conversation: one(dmConversations, {
    fields: [fileConversations.conversationId],
    references: [dmConversations.id],
  }),
  linker: one(users, {
    fields: [fileConversations.linkedBy],
    references: [users.id],
  }),
}));
