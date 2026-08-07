import { faker } from '@faker-js/faker'
import { createId } from '@paralleldrive/cuid2'
import { db } from '../db';
import { users } from '../schema/auth';
import { drives, pages } from '../schema/core';
import { conversations, messages } from '../schema/conversations';
import { driveMembers, pagePermissions } from '../schema/members';
import { eq } from 'drizzle-orm';

export const factories = {
  async createUser(overrides?: Partial<typeof users.$inferInsert>) {
    const user = {
      id: createId(),
      name: faker.person.fullName(),
      email: faker.internet.email(),
      emailVerified: new Date(),
      provider: 'email' as const,
      tokenVersion: 0,
      role: 'user' as const,
      currentAiProvider: 'openai',
      currentAiModel: 'openai/gpt-5.6-luna',
      storageUsedBytes: 0,
      subscriptionTier: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(users).values(user).returning()
    return created
  },

  async createDrive(ownerId: string, overrides?: Partial<typeof drives.$inferInsert>) {
    const name = faker.company.name()
    const drive = {
      id: createId(),
      name,
      slug: faker.helpers.slugify(name).toLowerCase(),
      ownerId,
      isTrashed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(drives).values(drive).returning()
    return created
  },

  async createPage(driveId: string, overrides?: Partial<typeof pages.$inferInsert>) {
    const page = {
      id: createId(),
      driveId,
      title: faker.lorem.words(3),
      type: 'DOCUMENT' as const,
      content: faker.lorem.paragraphs(2),
      position: Math.random(),
      isTrashed: false,
      processingStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(pages).values(page).returning()
    return created
  },

  /**
   * A page-chat message, seeded THE WAY PRODUCTION WRITES ONE since the
   * message-table merge (epic "Agent-Session Single Source of Truth", Phase 4
   * / D6): a real `conversations` row (`type='page'`, `contextId = pageId`)
   * plus its row in the ONE `messages` table.
   *
   * The conversation is not optional decoration — `messages.conversationId`
   * carries a validated, cascading FK, and a page-chat row's PAGE is derived
   * from that conversation (`unified-message-scope.ts`), so a fixture without
   * one is neither writable nor readable. The conversation's owner is
   * `overrides.userId` when given, else the drive owner (`conversations.userId`
   * is NOT NULL and FK'd, so it needs a real user).
   *
   * `pageId` is therefore a parameter, not a column: it selects/creates the
   * conversation this message hangs off. `chat_messages` — where it WAS a
   * column — was dropped at Phase 4 PR 15.
   */
  async createChatMessage(pageId: string, overrides?: Partial<typeof messages.$inferInsert>) {
    const message = {
      id: createId(),
      conversationId: createId(),
      role: 'user',
      content: faker.lorem.sentence(),
      createdAt: new Date(),
      isActive: true,
      messageType: 'standard' as const,
      ...overrides,
    }

    const [existingConversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, message.conversationId))
      .limit(1)

    if (!existingConversation) {
      let ownerId = message.userId ?? null
      if (!ownerId) {
        const [owner] = await db
          .select({ ownerId: drives.ownerId })
          .from(pages)
          .innerJoin(drives, eq(drives.id, pages.driveId))
          .where(eq(pages.id, pageId))
          .limit(1)
        ownerId = owner?.ownerId ?? null
      }
      if (ownerId) {
        await db.insert(conversations).values({
          id: message.conversationId,
          userId: ownerId,
          type: 'page',
          contextId: pageId,
          title: null,
          isActive: true,
          createdAt: message.createdAt,
        }).onConflictDoNothing()
      }
    }

    const [created] = await db.insert(messages).values({
      id: message.id,
      conversationId: message.conversationId,
      userId: message.userId ?? null,
      role: message.role,
      content: message.content,
      messageType: message.messageType,
      toolCalls: message.toolCalls ?? null,
      toolResults: message.toolResults ?? null,
      createdAt: message.createdAt,
      isActive: message.isActive,
      editedAt: message.editedAt ?? null,
      status: message.status ?? 'complete',
      sourceAgentId: message.sourceAgentId ?? null,
    }).returning()
    return created
  },

  async createPagePermission(
    pageId: string,
    userId: string,
    overrides?: Partial<typeof pagePermissions.$inferInsert>
  ) {
    const permission = {
      id: createId(),
      pageId,
      userId,
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
      grantedAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(pagePermissions).values(permission).returning()
    return created
  },

  async createDriveMember(
    driveId: string,
    userId: string,
    overrides?: Partial<typeof driveMembers.$inferInsert>
  ) {
    const member = {
      id: createId(),
      driveId,
      userId,
      role: 'MEMBER' as const,
      invitedAt: new Date(),
      acceptedAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(driveMembers).values(member).returning()
    return created
  },
}
