/**
 * Activity Logs Compliance Tests - TDD Phase 1
 *
 * Tests for enterprise audit trail compliance:
 * - Actor snapshot fields (actorEmail, actorDisplayName) for denormalized actor info
 * - FK behavior (onDelete: 'set null') to preserve audit logs when users are deleted
 * - SOX/GDPR compliance patterns
 *
 * CLEANUP IS ROW-SCOPED, ON PURPOSE. This file used to end each case with
 *   TRUNCATE TABLE activity_logs, page_permissions, pages, drive_members, drives, users CASCADE
 * which is wrong twice over on a SHARED database. Turbo runs `test:coverage`
 * for @pagespace/db, @pagespace/lib and web concurrently against the one CI
 * Postgres, so that statement (a) took an ACCESS EXCLUSIVE lock on six tables
 * those other suites were mid-insert on — deadlocking (40P01) against their
 * FK RowShare locks, after which the leftover fixture row made the next
 * beforeEach fail with 23505 on users_email_unique — and (b) when it *did*
 * win the race, it silently deleted the other packages' fixtures (the hazard
 * already documented in ../test/setup.ts).
 *
 * So: seed nothing but a user + a drive, record every activity_logs row this
 * file writes, and delete exactly those. Nothing here needs an empty table —
 * the only non-id lookup is scoped by a per-test unique actorEmail.
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

  /**
   * Ids of the activity_logs rows written by the current test. Tracked rather
   * than derived from userId/driveId because both FKs are `onDelete: 'set null'`
   * — the cases that delete the user (the whole point of this suite) leave logs
   * whose owning ids are already gone.
   */
  let seededLogIds: string[] = []

  /** Mint an activity_logs id and register it for this test's cleanup. */
  function seedLogId(): string {
    const id = createId()
    seededLogIds.push(id)
    return id
  }

  beforeEach(async () => {
    seededLogIds = []
    testUser = await factories.createUser({
      // Unique per test: `users.email` is UNIQUE, and a fixed address makes the
      // suite collide with itself (and with any other suite on the shared CI
      // database) the moment one cleanup does not land.
      email: `activity-logs-compliance-${createId()}@example.test`,
      name: 'John Doe',
    })
    testDrive = await factories.createDrive(testUser.id)
  })

  afterEach(async () => {
    // Row-scoped cleanup — delete ONLY what this test seeded. Deleting the user
    // cascades the drive away (drives.ownerId is onDelete: 'cascade'), but the
    // logs must go first: they are deliberately outlived by their FKs.
    if (seededLogIds.length > 0) {
      await db.delete(activityLogs).where(inArray(activityLogs.id, seededLogIds))
    }
    await db.delete(drives).where(eq(drives.id, testDrive.id))
    await db.delete(users).where(eq(users.id, testUser.id))
  })

  describe('actor snapshot fields', () => {
    it('should have actorEmail field for denormalized actor info', async () => {
      // Create an activity log with actorEmail
      const logId = seedLogId()
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
      const logId = seedLogId()
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
      const logId = seedLogId()

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
      const logId = seedLogId()
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
      const logId = seedLogId()
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
      const log1Id = seedLogId()
      const log2Id = seedLogId()
      const log3Id = seedLogId()

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
      const logId = seedLogId()
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
      const logId = seedLogId()

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
