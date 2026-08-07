/**
 * Activity Logs Compliance Tests - TDD Phase 1
 *
 * Tests for enterprise audit trail compliance:
 * - Actor snapshot fields (actorEmail, actorDisplayName) for denormalized actor info
 * - FK behavior (onDelete: 'set null') to preserve audit logs when users are deleted
 * - SOX/GDPR compliance patterns
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { activityLogs } from '../schema/monitoring'
import { users } from '../schema/auth'
import { drives } from '../schema/core'
import { factories } from './factories'
import { createId } from '@paralleldrive/cuid2'

describe('activity_logs schema compliance', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  /** Every `activity_logs.id` this file inserts, so afterEach can reap exactly those. */
  const createdLogIds: string[] = []
  const trackLog = (id: string): string => {
    createdLogIds.push(id)
    return id
  }

  beforeEach(async () => {
    testUser = await factories.createUser({
      // Unique per test. `users.email` is UNIQUE, so a fixed address makes this
      // suite collide with ITSELF the moment one cleanup does not land — the
      // other half of the CI failure described in afterEach below. Once the
      // TRUNCATE lost the lock race and left its row behind, the next beforeEach
      // died on 23505 `users_email_unique` (Key (email)=(john@example.com)
      // already exists), turning one lock error into four red tests. A unique
      // address also cannot collide with another suite on the shared database.
      email: `activity-logs-compliance-${createId()}@example.test`,
      name: 'John Doe',
    })
    testDrive = await factories.createDrive(testUser.id)
  })

  afterEach(async () => {
    // Delete ONLY what this test created.
    //
    // This used to be `TRUNCATE activity_logs, page_permissions, pages,
    // drive_members, drives, users CASCADE`. CI runs
    // `turbo run test:coverage` across @pagespace/db, @pagespace/lib,
    // apps/web, apps/admin and apps/realtime CONCURRENTLY against one
    // database, and TRUNCATE takes ACCESS EXCLUSIVE on all six tables while
    // those suites hold ROW SHARE on them. Both outcomes were live failures:
    // losing the lock race deadlocked (40P01) and failed this file's own
    // tests, and winning it deleted the other suites' fixtures mid-request —
    // apps/admin's broadcast-templates test 403s with `user_not_found`
    // because the admin user it had just inserted was gone.
    //
    // `activityLogs.userId`/`driveId` are both `onDelete: 'set null'`, so the
    // FK-behaviour tests below leave their rows reachable by NEITHER key once
    // they delete the user and drive. Hence the tracked id list rather than a
    // predicate: it is the only thing that still finds those rows.
    if (createdLogIds.length > 0) {
      await db.delete(activityLogs).where(inArray(activityLogs.id, createdLogIds))
      createdLogIds.length = 0
    }
    // No-ops for the tests that already deleted these themselves.
    await db.delete(drives).where(eq(drives.id, testDrive.id))
    await db.delete(users).where(eq(users.id, testUser.id))
  })

  describe('actor snapshot fields', () => {
    it('should have actorEmail field for denormalized actor info', async () => {
      // Create an activity log with actorEmail
      const logId = trackLog(createId())
      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        actorEmail: testUser.email,
        actorDisplayName: testUser.name,
        operation: 'create',
        resourceType: 'page',
        resourceId: createId(),
        resourceTitle: 'Test Page',
        driveId: testDrive.id,
        isAiGenerated: false,
        isArchived: false,
      })

      // Verify the log was created with actorEmail
      const log = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      expect(log).toBeDefined()
      expect(log?.actorEmail).toBe(testUser.email)
    })

    it('should have actorDisplayName field for denormalized actor info', async () => {
      const logId = trackLog(createId())
      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        actorEmail: testUser.email,
        actorDisplayName: 'John Doe',
        operation: 'update',
        resourceType: 'page',
        resourceId: createId(),
        driveId: testDrive.id,
        isAiGenerated: false,
        isArchived: false,
      })

      const log = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      expect(log).toBeDefined()
      expect(log?.actorDisplayName).toBe('John Doe')
    })

    it('should use default actorEmail when not provided', async () => {
      // When actorEmail is omitted, the default 'legacy@unknown' is used
      const logId = trackLog(createId())

      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        // actorEmail intentionally omitted - should use default
        operation: 'create',
        resourceType: 'page',
        resourceId: createId(),
        driveId: testDrive.id,
        isAiGenerated: false,
        isArchived: false,
      } as typeof activityLogs.$inferInsert)

      const log = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      expect(log).toBeDefined()
      expect(log?.actorEmail).toBe('legacy@unknown')
    })

    it('should allow null actorDisplayName', async () => {
      const logId = trackLog(createId())
      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        actorEmail: testUser.email,
        // actorDisplayName intentionally omitted
        operation: 'create',
        resourceType: 'page',
        resourceId: createId(),
        driveId: testDrive.id,
        isAiGenerated: false,
        isArchived: false,
      })

      const log = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      expect(log).toBeDefined()
      expect(log?.actorDisplayName).toBeNull()
    })
  })

  describe('user deletion FK behavior (onDelete: set null)', () => {
    it('should preserve audit logs when user is deleted (userId becomes null)', async () => {
      // Create activity log for user
      const logId = trackLog(createId())
      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        actorEmail: testUser.email,
        actorDisplayName: testUser.name,
        operation: 'create',
        resourceType: 'page',
        resourceId: createId(),
        resourceTitle: 'Important Document',
        driveId: testDrive.id,
        isAiGenerated: false,
        isArchived: false,
      })

      // Verify log exists with userId
      const logBefore = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })
      expect(logBefore?.userId).toBe(testUser.id)

      // Delete the drive first (required for user deletion)
      await db.delete(drives).where(eq(drives.id, testDrive.id))

      // Delete the user
      await db.delete(users).where(eq(users.id, testUser.id))

      // Verify audit log still exists with userId set to null
      const logAfter = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      expect(logAfter).toBeDefined()
      expect(logAfter?.userId).toBeNull()
      // Actor info preserved!
      expect(logAfter?.actorEmail).toBe(testUser.email)
      expect(logAfter?.actorDisplayName).toBe('John Doe')
      // Audit data preserved!
      expect(logAfter?.operation).toBe('create')
      expect(logAfter?.resourceTitle).toBe('Important Document')
    })

    it('should preserve multiple audit logs when user is deleted', async () => {
      // Create multiple activity logs
      const log1Id = trackLog(createId())
      const log2Id = trackLog(createId())
      const log3Id = trackLog(createId())

      await db.insert(activityLogs).values([
        {
          id: log1Id,
          userId: testUser.id,
          actorEmail: testUser.email,
          actorDisplayName: testUser.name,
          operation: 'create',
          resourceType: 'page',
          resourceId: createId(),
          driveId: testDrive.id,
          isAiGenerated: false,
          isArchived: false,
        },
        {
          id: log2Id,
          userId: testUser.id,
          actorEmail: testUser.email,
          actorDisplayName: testUser.name,
          operation: 'update',
          resourceType: 'page',
          resourceId: createId(),
          driveId: testDrive.id,
          isAiGenerated: true,
          aiProvider: 'openai',
          aiModel: 'gpt-4',
          isArchived: false,
        },
        {
          id: log3Id,
          userId: testUser.id,
          actorEmail: testUser.email,
          actorDisplayName: testUser.name,
          operation: 'permission_grant',
          resourceType: 'permission',
          resourceId: createId(),
          driveId: testDrive.id,
          isAiGenerated: false,
          isArchived: false,
        },
      ])

      // Delete drive then user
      await db.delete(drives).where(eq(drives.id, testDrive.id))
      await db.delete(users).where(eq(users.id, testUser.id))

      // All logs should be preserved
      const logs = await db.query.activityLogs.findMany({
        where: eq(activityLogs.actorEmail, testUser.email),
      })

      expect(logs).toHaveLength(3)
      logs.forEach((log) => {
        expect(log.userId).toBeNull()
        expect(log.actorEmail).toBe(testUser.email)
        expect(log.actorDisplayName).toBe('John Doe')
      })
    })
  })

  describe('compliance requirements', () => {
    it('should preserve all audit data for SOX 7-year retention', async () => {
      const logId = trackLog(createId())
      const resourceId = createId()
      const contentSnapshot = '{"title":"Financial Report Q4","content":"Important financial data..."}'

      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        actorEmail: testUser.email,
        actorDisplayName: testUser.name,
        operation: 'update',
        resourceType: 'page',
        resourceId,
        resourceTitle: 'Financial Report Q4',
        driveId: testDrive.id,
        contentSnapshot,
        updatedFields: ['content', 'title'],
        previousValues: { title: 'Draft Report' },
        newValues: { title: 'Financial Report Q4' },
        metadata: { version: 2, auditReason: 'quarterly update' },
        isAiGenerated: false,
        isArchived: false,
      })

      const log = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      // All compliance-critical fields preserved
      expect(log?.timestamp).toBeDefined()
      expect(log?.actorEmail).toBe(testUser.email)
      expect(log?.operation).toBe('update')
      expect(log?.resourceType).toBe('page')
      expect(log?.resourceId).toBe(resourceId)
      expect(log?.contentSnapshot).toBe(contentSnapshot)
      expect(log?.updatedFields).toEqual(['content', 'title'])
      expect(log?.previousValues).toEqual({ title: 'Draft Report' })
      expect(log?.newValues).toEqual({ title: 'Financial Report Q4' })
    })

    it('should support AI attribution for automated audit trails', async () => {
      const logId = trackLog(createId())

      await db.insert(activityLogs).values({
        id: logId,
        userId: testUser.id,
        actorEmail: testUser.email,
        actorDisplayName: testUser.name,
        operation: 'create',
        resourceType: 'page',
        resourceId: createId(),
        driveId: testDrive.id,
        isAiGenerated: true,
        aiProvider: 'anthropic',
        aiModel: 'claude-3-opus',
        aiConversationId: 'conv_abc123',
        isArchived: false,
      })

      const log = await db.query.activityLogs.findFirst({
        where: eq(activityLogs.id, logId),
      })

      expect(log?.isAiGenerated).toBe(true)
      expect(log?.aiProvider).toBe('anthropic')
      expect(log?.aiModel).toBe('claude-3-opus')
      expect(log?.aiConversationId).toBe('conv_abc123')
    })
  })
})
