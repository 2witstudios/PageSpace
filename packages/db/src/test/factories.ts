import { faker } from '@faker-js/faker'
import { createId } from '@paralleldrive/cuid2'
import { users, drives, pages, chatMessages, pagePermissions, driveMembers, auditEvents, pageVersions, aiOperations } from '../schema'
import { db } from '../index'
import bcrypt from 'bcryptjs'

export const factories = {
  async createUser(overrides?: Partial<typeof users.$inferInsert>) {
    const user = {
      id: createId(),
      name: faker.person.fullName(),
      email: faker.internet.email(),
      password: await bcrypt.hash('password123', 10),
      emailVerified: new Date(),
      provider: 'email' as const,
      tokenVersion: 0,
      role: 'user' as const,
      currentAiProvider: 'pagespace',
      currentAiModel: 'glm-4.5-air',
      storageUsedBytes: 0,
      activeUploads: 0,
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

  async createChatMessage(pageId: string, overrides?: Partial<typeof chatMessages.$inferInsert>) {
    const message = {
      id: createId(),
      pageId,
      role: 'user',
      content: faker.lorem.sentence(),
      createdAt: new Date(),
      isActive: true,
      agentRole: 'PARTNER',
      messageType: 'standard' as const,
      ...overrides,
    }

    const [created] = await db.insert(chatMessages).values(message).returning()
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

  async createAuditEvent(overrides?: Partial<typeof auditEvents.$inferInsert>) {
    const auditEvent = {
      id: createId(),
      actionType: 'PAGE_UPDATE' as const,
      entityType: 'PAGE' as const,
      entityId: createId(),
      userId: createId(),
      isAiAction: false,
      description: faker.lorem.sentence(),
      createdAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(auditEvents).values(auditEvent).returning()
    return created
  },

  async createPageVersion(
    pageId: string,
    overrides?: Partial<typeof pageVersions.$inferInsert>
  ) {
    const version = {
      id: createId(),
      pageId,
      versionNumber: 1,
      content: { content: faker.lorem.paragraphs(2) },
      title: faker.lorem.words(3),
      pageType: 'DOCUMENT',
      isAiGenerated: false,
      createdAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(pageVersions).values(version).returning()
    return created
  },

  async createAiOperation(userId: string, overrides?: Partial<typeof aiOperations.$inferInsert>) {
    const operation = {
      id: createId(),
      userId,
      agentType: 'ASSISTANT' as const,
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'edit',
      prompt: faker.lorem.sentence(),
      status: 'completed',
      createdAt: new Date(),
      ...overrides,
    }

    const [created] = await db.insert(aiOperations).values(operation).returning()
    return created
  },
}