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
import { schema } from '@pagespace/db/schema';
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
  return drizzle(pool, { schema });
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
      file_pages,
      files,
      messages,
      conversations,
      agent_workspace_shells,
      agent_workspaces,
      channel_read_status,
      channel_message_reactions,
      channel_messages,
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
      emailBidx: 'bidx_alice_test_local',
      provider: 'email' as const,
    },
    member: {
      id: 'test_user_member_002',
      name: 'Bob Member',
      email: 'bob@test.local',
      emailBidx: 'bidx_bob_test_local',
      provider: 'email' as const,
    },
    outsider: {
      id: 'test_user_outsider_003',
      name: 'Eve Outsider',
      email: 'eve@test.local',
      emailBidx: 'bidx_eve_test_local',
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
      description: 'The drive landing page',
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
  /**
   * The page conversation the fixture's messages hang off.
   *
   * A page-chat message MUST name a real `conversations` row —
   * `messages.conversationId` carries a validated, cascading FK, and a
   * message's PAGE is derived from that conversation. A fixture without a
   * parent row is therefore not a state the application can produce, so it is
   * seeded the way production writes one: `type='page'` with
   * `contextId = pageId` (the shape `conversations_page_context_present_chk`
   * requires and the reader cutover derives the page from).
   */
  conversations: {
    pageChat: {
      id: 'test_convo_inline_001',
      type: 'page' as const,
      title: 'Grandchild page chat',
      /**
       * Bound to a session, with a non-default `rev`, a closed-listing stamp
       * and the shared flag set — the four columns the export used to drop on
       * the floor. Every one of them has a non-default value here so the
       * round-trip proves the value SURVIVED rather than that the tenant's
       * column default happened to match.
       */
      workspaceId: 'test_agent_session_001',
      rev: 7,
      isShared: true,
    },
  },
  /**
   * The working context `conversations.pageChat` is bound to. Carried by the
   * export because `workspaceId` is write-once — a migration that drops the
   * binding cannot be repaired afterwards. Its Sprite-identity columns are
   * seeded NON-NULL precisely so the round-trip can assert they DO NOT travel.
   */
  agentWorkspaces: {
    workspace: {
      id: 'test_agent_session_001',
      name: 'Team workspace',
      sandboxId: 'sprite-source-fleet-001',
      spriteInstanceId: 'sprite-instance-source-001',
    },
  },
  /**
   * A terminal inside that session. `coldTail` is the scrollback of its last
   * dead incarnation — user output with no other home in the bundle, and the
   * reason this table is carried at all. `spriteExecId` is seeded non-NULL for
   * the same reason the workspace's Sprite columns are: so the round-trip can
   * assert it DOES NOT travel.
   */
  agentWorkspaceShells: {
    shell: {
      id: 'test_agent_shell_001',
      workspaceId: 'test_agent_session_001',
      name: 'build',
      agentType: 'shell',
      command: 'bun run dev',
      coldTail: '$ bun run dev\nerror: port 3000 already in use\n',
      coldTailHasOutput: true,
      spriteExecId: 'sprite-exec-source-001',
    },
  },
  messages: {
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
  const { users, drives, pages, conversations, agentWorkspaces, agentWorkspaceShells, messages, files, pagePermissions, tags } = FIXTURES;
  const now = new Date();

  // Users. `emailBidx` is seeded because it is the LOOKUP KEY for an encrypted
  // email (`users_email_bidx_idx`) — a migration that drops it leaves every
  // migrated account unfindable by email, i.e. unable to log in.
  await db.execute(sql`
    INSERT INTO users (id, name, email, "emailBidx", provider, "createdAt", "updatedAt")
    VALUES
      (${users.owner.id}, ${users.owner.name}, ${users.owner.email}, ${users.owner.emailBidx}, ${users.owner.provider}, ${now}, ${now}),
      (${users.member.id}, ${users.member.name}, ${users.member.email}, ${users.member.emailBidx}, ${users.member.provider}, ${now}, ${now}),
      (${users.outsider.id}, ${users.outsider.name}, ${users.outsider.email}, ${users.outsider.emailBidx}, ${users.outsider.provider}, ${now}, ${now})
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

  // Pages (tree: root -> child -> grandchild). The grandchild carries the
  // AI_CHAT agent settings (`sandboxEnabled`, `userScopedAccess`,
  // `toolExposureMode`) and the root carries `description`/`isPrivate`, all set
  // AWAY from their column defaults so a round-trip can tell a carried value
  // from a default one.
  await db.execute(sql`
    INSERT INTO pages (id, title, type, content, position, "driveId", "parentId", "createdBy", description, "isPrivate", "toolExposureMode", "sandboxEnabled", "userScopedAccess", "createdAt", "updatedAt")
    VALUES
      (${pages.root.id}, ${pages.root.title}, ${pages.root.type}, ${pages.root.content}, ${pages.root.position}, ${drives.shared.id}, NULL, ${users.owner.id}, ${pages.root.description}, TRUE, 'upfront', FALSE, FALSE, ${now}, ${now}),
      (${pages.child.id}, ${pages.child.title}, ${pages.child.type}, ${pages.child.content}, ${pages.child.position}, ${drives.shared.id}, ${pages.root.id}, ${users.owner.id}, NULL, FALSE, 'upfront', FALSE, FALSE, ${now}, ${now}),
      (${pages.grandchild.id}, ${pages.grandchild.title}, ${pages.grandchild.type}, ${pages.grandchild.content}, ${pages.grandchild.position}, ${drives.shared.id}, ${pages.child.id}, ${users.owner.id}, NULL, FALSE, 'search', TRUE, TRUE, ${now}, ${now})
  `);

  // The drive's landing page — a FORWARD reference from drives to pages, which
  // is why the export emits it as a trailing UPDATE and why it can only be set
  // here, after the pages exist.
  await db.execute(sql`
    UPDATE drives SET "homePageId" = ${pages.root.id} WHERE id = ${drives.shared.id}
  `);

  // The working context the conversation below is bound to. Its Sprite columns
  // are deliberately non-NULL: the export must NOT carry them.
  await db.execute(sql`
    INSERT INTO agent_workspaces (id, "driveId", "ownerId", name, "sandboxId", "spriteInstanceId", "createdAt", "updatedAt")
    VALUES (${agentWorkspaces.workspace.id}, ${drives.shared.id}, ${users.owner.id}, ${agentWorkspaces.workspace.name}, ${agentWorkspaces.workspace.sandboxId}, ${agentWorkspaces.workspace.spriteInstanceId}, ${now}, ${now})
  `);

  // That session's terminal. `spriteExecId` is deliberately non-NULL: the
  // export must NOT carry it, exactly as with the workspace's Sprite columns.
  await db.execute(sql`
    INSERT INTO agent_workspace_shells (id, "workspaceId", "ownerId", name, "agentType", command, "coldTail", "coldTailAt", "coldTailHasOutput", "spriteExecId", "createdAt", "updatedAt")
    VALUES (${agentWorkspaceShells.shell.id}, ${agentWorkspaceShells.shell.workspaceId}, ${users.owner.id}, ${agentWorkspaceShells.shell.name}, ${agentWorkspaceShells.shell.agentType}, ${agentWorkspaceShells.shell.command}, ${agentWorkspaceShells.shell.coldTail}, ${now}, ${agentWorkspaceShells.shell.coldTailHasOutput}, ${agentWorkspaceShells.shell.spriteExecId}, ${now}, ${now})
  `);

  // The page conversation the chat messages below belong to. Required since
  // 0248 gave chat_messages.conversationId a real FK — see FIXTURES.conversations.
  await db.execute(sql`
    INSERT INTO conversations (id, "userId", title, type, "contextId", "workspaceId", "closedInWorkspaceAt", rev, "isShared", "lastMessageAt", "createdAt", "updatedAt")
    VALUES (${conversations.pageChat.id}, ${users.owner.id}, ${conversations.pageChat.title}, ${conversations.pageChat.type}, ${pages.grandchild.id}, ${conversations.pageChat.workspaceId}, ${now}, ${conversations.pageChat.rev}, ${conversations.pageChat.isShared}, ${now}, ${now}, ${now})
  `);

  // Chat messages, in the ONE message table. Their page is their
  // conversation's (`type='page'`, `contextId` = the grandchild AI_CHAT page)
  // — there is no per-row page column since Phase 4 PR 15 dropped it.
  await db.execute(sql`
    INSERT INTO messages (id, "conversationId", role, content, "userId", "createdAt")
    VALUES
      (${messages.msg1.id}, ${messages.msg1.conversationId}, ${messages.msg1.role}, ${messages.msg1.content}, ${users.owner.id}, ${now}),
      (${messages.msg2.id}, ${messages.msg2.conversationId}, ${messages.msg2.role}, ${messages.msg2.content}, NULL, ${now})
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
