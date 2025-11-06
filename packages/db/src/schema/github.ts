import { pgTable, text, timestamp, integer, index, boolean, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';

/**
 * GitHub OAuth connections for users
 * Stores encrypted access tokens and user GitHub information
 */
export const githubConnections = pgTable('github_connections', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // GitHub OAuth data
  githubUserId: text('githubUserId').notNull(),
  githubUsername: text('githubUsername').notNull(),
  githubEmail: text('githubEmail'),
  githubAvatarUrl: text('githubAvatarUrl'),

  // Encrypted access token
  encryptedAccessToken: text('encryptedAccessToken').notNull(),
  tokenType: text('tokenType').default('Bearer'),
  scope: text('scope'), // Space-separated OAuth scopes

  // Token metadata
  lastUsed: timestamp('lastUsed', { mode: 'date' }),
  expiresAt: timestamp('expiresAt', { mode: 'date' }), // For OAuth apps with expiring tokens

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('github_connections_user_id_idx').on(table.userId),
    githubUserIdx: index('github_connections_github_user_id_idx').on(table.githubUserId),
  };
});

/**
 * Connected GitHub repositories
 * Represents repositories that are accessible within a PageSpace drive
 */
export const githubRepositories = pgTable('github_repositories', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  connectionId: text('connectionId').notNull().references(() => githubConnections.id, { onDelete: 'cascade' }),

  // Repository identification
  githubRepoId: integer('githubRepoId').notNull(), // GitHub's numeric repo ID
  owner: text('owner').notNull(), // Repository owner/org
  name: text('name').notNull(), // Repository name
  fullName: text('fullName').notNull(), // owner/name

  // Repository metadata
  description: text('description'),
  isPrivate: boolean('isPrivate').default(false).notNull(),
  defaultBranch: text('defaultBranch').default('main').notNull(),
  language: text('language'), // Primary language

  // Repository URLs
  htmlUrl: text('htmlUrl').notNull(),
  cloneUrl: text('cloneUrl').notNull(),

  // Repository statistics (cached for performance)
  stargazersCount: integer('stargazersCount').default(0),
  forksCount: integer('forksCount').default(0),
  openIssuesCount: integer('openIssuesCount').default(0),

  // Sync metadata
  lastSyncedAt: timestamp('lastSyncedAt', { mode: 'date' }),
  syncError: text('syncError'), // Last sync error message if any

  // Configuration
  enabled: boolean('enabled').default(true).notNull(),
  branches: jsonb('branches').$type<string[]>(), // Specific branches to index, null = all

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    driveIdx: index('github_repositories_drive_id_idx').on(table.driveId),
    connectionIdx: index('github_repositories_connection_id_idx').on(table.connectionId),
    githubRepoIdx: index('github_repositories_github_repo_id_idx').on(table.githubRepoId),
    fullNameIdx: index('github_repositories_full_name_idx').on(table.fullName),
  };
});

/**
 * Code embed blocks in documents
 * Stores references to specific code snippets from GitHub repositories
 * These maintain live connections to source code
 */
export const githubCodeEmbeds = pgTable('github_code_embeds', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  repositoryId: text('repositoryId').notNull().references(() => githubRepositories.id, { onDelete: 'cascade' }),

  // File location
  filePath: text('filePath').notNull(), // Path to file in repo
  branch: text('branch').notNull(), // Branch or commit SHA

  // Line range (null = entire file)
  startLine: integer('startLine'),
  endLine: integer('endLine'),

  // Cached content and metadata
  content: text('content'), // Cached code snippet
  language: text('language'), // Programming language for syntax highlighting
  fileSize: integer('fileSize'), // Size in bytes

  // Version tracking
  commitSha: text('commitSha'), // SHA of the commit when embedded
  lastFetchedAt: timestamp('lastFetchedAt', { mode: 'date' }),
  fetchError: text('fetchError'), // Error message if fetch failed

  // Display metadata
  showLineNumbers: boolean('showLineNumbers').default(true).notNull(),
  highlightLines: jsonb('highlightLines').$type<number[]>(), // Lines to highlight

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    repositoryIdx: index('github_code_embeds_repository_id_idx').on(table.repositoryId),
    filePathIdx: index('github_code_embeds_file_path_idx').on(table.filePath),
    branchIdx: index('github_code_embeds_branch_idx').on(table.branch),
  };
});

/**
 * Code search cache
 * Caches search results for performance
 */
export const githubSearchCache = pgTable('github_search_cache', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),

  // Search query
  query: text('query').notNull(),
  repositoryIds: jsonb('repositoryIds').$type<string[]>(), // Repositories searched

  // Search results (cached)
  results: jsonb('results').$type<{
    filePath: string;
    repository: string;
    matches: {
      line: number;
      content: string;
      score: number;
    }[];
  }[]>(),

  // Cache metadata
  resultCount: integer('resultCount').default(0),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    driveIdx: index('github_search_cache_drive_id_idx').on(table.driveId),
    queryIdx: index('github_search_cache_query_idx').on(table.query),
    expiresIdx: index('github_search_cache_expires_at_idx').on(table.expiresAt),
  };
});

// Relations

export const githubConnectionsRelations = relations(githubConnections, ({ one, many }) => ({
  user: one(users, {
    fields: [githubConnections.userId],
    references: [users.id],
  }),
  repositories: many(githubRepositories),
}));

export const githubRepositoriesRelations = relations(githubRepositories, ({ one, many }) => ({
  drive: one(drives, {
    fields: [githubRepositories.driveId],
    references: [drives.id],
  }),
  connection: one(githubConnections, {
    fields: [githubRepositories.connectionId],
    references: [githubConnections.id],
  }),
  codeEmbeds: many(githubCodeEmbeds),
}));

export const githubCodeEmbedsRelations = relations(githubCodeEmbeds, ({ one }) => ({
  repository: one(githubRepositories, {
    fields: [githubCodeEmbeds.repositoryId],
    references: [githubRepositories.id],
  }),
}));

export const githubSearchCacheRelations = relations(githubSearchCache, ({ one }) => ({
  drive: one(drives, {
    fields: [githubSearchCache.driveId],
    references: [drives.id],
  }),
}));
