/**
 * Test setup for migration integration tests.
 * Connects to postgres on port 5433 (docker-compose.test.yml).
 * Seeds known test data, truncates between test runs.
 *
 * @integration - requires running postgres
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '@pagespace/db';
import path from 'path';

const TEST_DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://user:password@localhost:5433/pagespace_test';

let pool: Pool;

export function getTestDatabaseUrl(): string {
  return TEST_DB_URL;
}

export function createTestDb() {
  pool = new Pool({ connectionString: TEST_DB_URL, ssl: false });
  return drizzle(pool, { schema: schema.schema ?? schema });
}

export type TestDb = ReturnType<typeof createTestDb>;

export async function runMigrations(db: TestDb): Promise<void> {
  const migrationsFolder = path.resolve(
    __dirname,
    '../../packages/db/drizzle',
  );
  await migrate(db, { migrationsFolder });
}

/** Truncate all user-data tables in reverse FK order */
export async function truncateAll(db: TestDb): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      favorites,
      user_mentions,
      mentions,
      page_permissions,
      permissions,
      file_pages,
      files,
      messages,
      conversations,
      channel_read_status,
      channel_message_reactions,
      channel_messages,
      chat_messages,
      page_tags,
      tags,
      pages,
      drive_members,
      drive_roles,
      drives,
      user_profiles,
      users
    CASCADE
  `);
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}

// ────────────────────────────────────────────────────
// Fixed test fixture IDs (cuid2-like, deterministic)
// ────────────────────────────────────────────────────

export const FIXTURES = {
  users: {
    owner: {
      id: 'test_user_owner_001',
      name: 'Alice Owner',
      email: 'alice@test.local',
      provider: 'email' as const,
    },
    member: {
      id: 'test_user_member_002',
      name: 'Bob Member',
      email: 'bob@test.local',
      provider: 'email' as const,
    },
    outsider: {
      id: 'test_user_outsider_003',
      name: 'Eve Outsider',
      email: 'eve@test.local',
      provider: 'email' as const,
    },
  },
  drives: {
    shared: {
      id: 'test_drive_shared_001',
      name: 'Team Drive',
      slug: 'team-drive',
    },
  },
  pages: {
    root: {
      id: 'test_page_root_001',
      title: 'Root Page',
      type: 'DOCUMENT' as const,
      position: 0,
      content: '<p>Root content</p>',
    },
    child: {
      id: 'test_page_child_002',
      title: 'Child Page',
      type: 'DOCUMENT' as const,
      position: 1,
      content: '<p>Child content</p>',
    },
    grandchild: {
      id: 'test_page_grandchild_003',
      title: 'Grandchild Page',
      type: 'AI_CHAT' as const,
      position: 0,
      content: '',
    },
  },
  chatMessages: {
    msg1: {
      id: 'test_chatmsg_001',
      role: 'user',
      content: 'Hello AI',
      conversationId: 'test_convo_inline_001',
    },
    msg2: {
      id: 'test_chatmsg_002',
      role: 'assistant',
      content: 'Hello human',
      conversationId: 'test_convo_inline_001',
    },
  },
  files: {
    blob: {
      id: 'test_file_blob_001',
      sizeBytes: 10,
      mimeType: 'text/plain',
      storagePath: 'test_file_blob_001/data.txt',
    },
  },
  permissions: {
    perm1: {
      id: 'test_perm_001',
      action: 'VIEW' as const,
      subjectType: 'USER' as const,
    },
  },
  pagePermissions: {
    pp1: {
      id: 'test_pageperm_001',
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    },
  },
  tags: {
    tag1: {
      id: 'test_tag_001',
      name: 'important',
      color: '#ff0000',
    },
  },
} as const;

/**
 * Seed the test database with known fixtures.
 * Call after truncateAll() in beforeEach.
 */
export async function seedFixtures(db: TestDb): Promise<void> {
  const { users, drives, pages, chatMessages, files, permissions, pagePermissions, tags } = FIXTURES;
  const now = new Date();

  // Users
  await db.execute(sql`
    INSERT INTO users (id, name, email, provider, "createdAt", "updatedAt")
    VALUES
      (${users.owner.id}, ${users.owner.name}, ${users.owner.email}, ${users.owner.provider}, ${now}, ${now}),
      (${users.member.id}, ${users.member.name}, ${users.member.email}, ${users.member.provider}, ${now}, ${now}),
      (${users.outsider.id}, ${users.outsider.name}, ${users.outsider.email}, ${users.outsider.provider}, ${now}, ${now})
  `);

  // User profiles
  await db.execute(sql`
    INSERT INTO user_profiles ("userId", "displayName", "createdAt", "updatedAt")
    VALUES
      (${users.owner.id}, ${users.owner.name}, ${now}, ${now}),
      (${users.member.id}, ${users.member.name}, ${now}, ${now})
  `);

  // Drives
  await db.execute(sql`
    INSERT INTO drives (id, name, slug, "ownerId", "createdAt", "updatedAt")
    VALUES (${drives.shared.id}, ${drives.shared.name}, ${drives.shared.slug}, ${users.owner.id}, ${now}, ${now})
  `);

  // Drive members
  await db.execute(sql`
    INSERT INTO drive_members (id, "driveId", "userId", role, "invitedAt")
    VALUES
      ('test_drivemember_001', ${drives.shared.id}, ${users.owner.id}, 'OWNER', ${now}),
      ('test_drivemember_002', ${drives.shared.id}, ${users.member.id}, 'MEMBER', ${now})
  `);

  // Pages (tree: root -> child -> grandchild)
  await db.execute(sql`
    INSERT INTO pages (id, title, type, content, position, "driveId", "parentId", "createdAt", "updatedAt")
    VALUES
      (${pages.root.id}, ${pages.root.title}, ${pages.root.type}, ${pages.root.content}, ${pages.root.position}, ${drives.shared.id}, NULL, ${now}, ${now}),
      (${pages.child.id}, ${pages.child.title}, ${pages.child.type}, ${pages.child.content}, ${pages.child.position}, ${drives.shared.id}, ${pages.root.id}, ${now}, ${now}),
      (${pages.grandchild.id}, ${pages.grandchild.title}, ${pages.grandchild.type}, ${pages.grandchild.content}, ${pages.grandchild.position}, ${drives.shared.id}, ${pages.child.id}, ${now}, ${now})
  `);

  // Chat messages (on the grandchild AI_CHAT page)
  await db.execute(sql`
    INSERT INTO chat_messages (id, "pageId", "conversationId", role, content, "userId", "createdAt")
    VALUES
      (${chatMessages.msg1.id}, ${pages.grandchild.id}, ${chatMessages.msg1.conversationId}, ${chatMessages.msg1.role}, ${chatMessages.msg1.content}, ${users.owner.id}, ${now}),
      (${chatMessages.msg2.id}, ${pages.grandchild.id}, ${chatMessages.msg2.conversationId}, ${chatMessages.msg2.role}, ${chatMessages.msg2.content}, NULL, ${now})
  `);

  // Files
  await db.execute(sql`
    INSERT INTO files (id, "driveId", "sizeBytes", "mimeType", "storagePath", "createdBy", "createdAt", "updatedAt")
    VALUES (${files.blob.id}, ${drives.shared.id}, ${files.blob.sizeBytes}, ${files.blob.mimeType}, ${files.blob.storagePath}, ${users.owner.id}, ${now}, ${now})
  `);

  // File-page link
  await db.execute(sql`
    INSERT INTO file_pages ("fileId", "pageId", "linkedBy", "linkedAt")
    VALUES (${files.blob.id}, ${pages.root.id}, ${users.owner.id}, ${now})
  `);

  // Legacy permissions
  await db.execute(sql`
    INSERT INTO permissions (id, action, "subjectType", "subjectId", "pageId", "createdAt")
    VALUES (${permissions.perm1.id}, ${permissions.perm1.action}, ${permissions.perm1.subjectType}, ${users.member.id}, ${pages.root.id}, ${now})
  `);

  // Page permissions
  await db.execute(sql`
    INSERT INTO page_permissions (id, "pageId", "userId", "canView", "canEdit", "canShare", "canDelete", "grantedBy", "grantedAt")
    VALUES (${pagePermissions.pp1.id}, ${pages.child.id}, ${users.member.id}, ${pagePermissions.pp1.canView}, ${pagePermissions.pp1.canEdit}, ${pagePermissions.pp1.canShare}, ${pagePermissions.pp1.canDelete}, ${users.owner.id}, ${now})
  `);

  // Tags + page tags
  await db.execute(sql`
    INSERT INTO tags (id, name, color)
    VALUES (${tags.tag1.id}, ${tags.tag1.name}, ${tags.tag1.color})
  `);

  await db.execute(sql`
    INSERT INTO page_tags ("pageId", "tagId")
    VALUES (${pages.root.id}, ${tags.tag1.id})
  `);

  // Mentions (root page mentions child page)
  await db.execute(sql`
    INSERT INTO mentions (id, "sourcePageId", "targetPageId", "createdAt")
    VALUES ('test_mention_001', ${pages.root.id}, ${pages.child.id}, ${now})
  `);

  // User mentions
  await db.execute(sql`
    INSERT INTO user_mentions (id, "sourcePageId", "targetUserId", "mentionedByUserId", "createdAt")
    VALUES ('test_usermention_001', ${pages.root.id}, ${users.member.id}, ${users.owner.id}, ${now})
  `);

  // Favorites
  await db.execute(sql`
    INSERT INTO favorites (id, "userId", "itemType", "pageId", position, "createdAt")
    VALUES ('test_favorite_001', ${users.owner.id}, 'page', ${pages.root.id}, 0, ${now})
  `);
}
