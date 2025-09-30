import { faker } from '@faker-js/faker'
import { createId } from '@paralleldrive/cuid2'
import { users, drives, pages, chatMessages, pagePermissions } from '../schema'
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
      currentAiModel: 'GLM-4.5-air',
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
}