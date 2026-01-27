import { describe, it, expect, beforeEach } from 'vitest'
import {
  getUserAccessLevel,
  canUserViewPage,
  canUserEditPage,
  canUserSharePage,
  canUserDeletePage,
} from '../permissions/permissions'
import { factories } from '@pagespace/db/test/factories'
import { db, users, pagePermissions, eq, and } from '@pagespace/db'
import { createId } from '@paralleldrive/cuid2'

describe('permissions system', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    // Clean up test data before each test
    // Use DELETE to avoid TRUNCATE CASCADE deadlocks with connection pool
    await db.delete(users)

    testUser = await factories.createUser()
    otherUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  describe('getUserAccessLevel', () => {
    it('grants full access to drive owner', async () => {
      const access = await getUserAccessLevel(testUser.id, testPage.id)

      expect(access).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })
    })

    it('returns null for user with no permissions', async () => {
      const access = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access).toBeNull()
    })

    it('returns specific permissions when granted', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const access = await getUserAccessLevel(otherUser.id, testPage.id)

      expect(access).toEqual({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      })
    })

    it('returns null for non-existent page (valid UUID)', async () => {
      // Use a valid CUID2 that doesn't exist in DB
      const nonExistentPageId = createId()
      const access = await getUserAccessLevel(testUser.id, nonExistentPageId)
      expect(access).toBeNull()
    })

    describe('ID validation', () => {
      it('returns null for empty userId', async () => {
        const access = await getUserAccessLevel('', testPage.id)
        expect(access).toBeNull()
      })

      it('returns null for empty pageId', async () => {
        const access = await getUserAccessLevel(testUser.id, '')
        expect(access).toBeNull()
      })

      it('returns null for non-UUID userId', async () => {
        const access = await getUserAccessLevel('not-a-uuid', testPage.id)
        expect(access).toBeNull()
      })

      it('returns null for non-UUID pageId', async () => {
        const access = await getUserAccessLevel(testUser.id, 'not-a-uuid')
        expect(access).toBeNull()
      })

      it('returns null for excessively long userId', async () => {
        const longId = 'a'.repeat(1000)
        const access = await getUserAccessLevel(longId, testPage.id)
        expect(access).toBeNull()
      })

      it('returns null for excessively long pageId', async () => {
        const longId = 'a'.repeat(1000)
        const access = await getUserAccessLevel(testUser.id, longId)
        expect(access).toBeNull()
      })

      it('returns null for null userId', async () => {
        const access = await getUserAccessLevel(null as unknown as string, testPage.id)
        expect(access).toBeNull()
      })

      it('returns null for undefined pageId', async () => {
        const access = await getUserAccessLevel(testUser.id, undefined as unknown as string)
        expect(access).toBeNull()
      })
    })

    it('grants full access to drive owner even with explicit lower permissions', async () => {
      // Create explicit permission with limited access
      await factories.createPagePermission(
        testPage.id,
        testUser.id,
        { canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: otherUser.id }
      )

      // Drive owner should still have full access
      const access = await getUserAccessLevel(testUser.id, testPage.id)

      expect(access).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })
    })

    it('grants full access to drive admin', async () => {
      // Add otherUser as admin to the drive
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' })

      const access = await getUserAccessLevel(otherUser.id, testPage.id)

      expect(access).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })
    })

    it('grants full access to drive admin even with explicit lower permissions', async () => {
      // Add otherUser as admin to the drive
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' })

      // Create explicit permission with limited access
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      // Drive admin should still have full access (admin overrides explicit permissions)
      const access = await getUserAccessLevel(otherUser.id, testPage.id)

      expect(access).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })
    })

    it('does not grant admin permissions to regular drive members', async () => {
      // Add otherUser as regular member (not admin) to the drive
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'MEMBER' })

      // Regular member without explicit permissions should not have access
      const access = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access).toBeNull()
    })
  })

  describe('canUserViewPage', () => {
    it('returns true for drive owner', async () => {
      const canView = await canUserViewPage(testUser.id, testPage.id)
      expect(canView).toBe(true)
    })

    it('returns false for user without permissions', async () => {
      const canView = await canUserViewPage(otherUser.id, testPage.id)
      expect(canView).toBe(false)
    })

    it('returns true for user with view permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const canView = await canUserViewPage(otherUser.id, testPage.id)
      expect(canView).toBe(true)
    })

    it('returns false for non-existent page (valid UUID)', async () => {
      const nonExistentPageId = '00000000-0000-4000-8000-000000000000'
      const canView = await canUserViewPage(testUser.id, nonExistentPageId)
      expect(canView).toBe(false)
    })

    it('returns false for invalid pageId', async () => {
      const canView = await canUserViewPage(testUser.id, 'invalid')
      expect(canView).toBe(false)
    })
  })

  describe('canUserEditPage', () => {
    it('returns true for drive owner', async () => {
      const canEdit = await canUserEditPage(testUser.id, testPage.id)
      expect(canEdit).toBe(true)
    })

    it('returns false for user without permissions', async () => {
      const canEdit = await canUserEditPage(otherUser.id, testPage.id)
      expect(canEdit).toBe(false)
    })

    it('returns true for user with edit permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const canEdit = await canUserEditPage(otherUser.id, testPage.id)
      expect(canEdit).toBe(true)
    })

    it('returns false for user with only view permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const canEdit = await canUserEditPage(otherUser.id, testPage.id)
      expect(canEdit).toBe(false)
    })
  })

  describe('canUserSharePage', () => {
    it('returns true for drive owner', async () => {
      const canShare = await canUserSharePage(testUser.id, testPage.id)
      expect(canShare).toBe(true)
    })

    it('returns false for user without permissions', async () => {
      const canShare = await canUserSharePage(otherUser.id, testPage.id)
      expect(canShare).toBe(false)
    })

    it('returns true for user with share permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: true, canDelete: false, grantedBy: testUser.id }
      )

      const canShare = await canUserSharePage(otherUser.id, testPage.id)
      expect(canShare).toBe(true)
    })

    it('returns false for user with edit but not share permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const canShare = await canUserSharePage(otherUser.id, testPage.id)
      expect(canShare).toBe(false)
    })
  })

  describe('canUserDeletePage', () => {
    it('returns true for drive owner', async () => {
      const canDelete = await canUserDeletePage(testUser.id, testPage.id)
      expect(canDelete).toBe(true)
    })

    it('returns false for user without permissions', async () => {
      const canDelete = await canUserDeletePage(otherUser.id, testPage.id)
      expect(canDelete).toBe(false)
    })

    it('returns true for user with delete permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: true, canDelete: true, grantedBy: testUser.id }
      )

      const canDelete = await canUserDeletePage(otherUser.id, testPage.id)
      expect(canDelete).toBe(true)
    })

    it('returns false for user with edit but not delete permission', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const canDelete = await canUserDeletePage(otherUser.id, testPage.id)
      expect(canDelete).toBe(false)
    })
  })

  describe('permission records via factory', () => {
    it('creates new permission record', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const access = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access?.canView).toBe(true)
      expect(access?.canEdit).toBe(true)
      expect(access?.canShare).toBe(false)
      expect(access?.canDelete).toBe(false)
    })

    it('grants delete permission when explicitly specified', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: true, canDelete: true, grantedBy: testUser.id }
      )

      const access = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access?.canDelete).toBe(true)
    })

    it('allows granting minimal permissions (view-only)', async () => {
      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const access = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access?.canView).toBe(true)
      expect(access?.canEdit).toBe(false)
      expect(access?.canShare).toBe(false)
      expect(access?.canDelete).toBe(false)
    })

    it('permission deletion does not affect other users', async () => {
      const thirdUser = await factories.createUser()

      await factories.createPagePermission(
        testPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      await factories.createPagePermission(
        testPage.id,
        thirdUser.id,
        { canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      // Delete otherUser's permission directly
      await db.delete(pagePermissions).where(
        and(
          eq(pagePermissions.pageId, testPage.id),
          eq(pagePermissions.userId, otherUser.id)
        )
      )

      const otherAccess = await getUserAccessLevel(otherUser.id, testPage.id)
      const thirdAccess = await getUserAccessLevel(thirdUser.id, testPage.id)

      expect(otherAccess).toBeNull()
      expect(thirdAccess).not.toBeNull()
      expect(thirdAccess?.canView).toBe(true)
    })
  })

  describe('permission inheritance (should not exist)', () => {
    it('does not inherit permissions from parent pages', async () => {
      const parentPage = await factories.createPage(testDrive.id, { type: 'FOLDER' })
      const childPage = await factories.createPage(testDrive.id, { parentId: parentPage.id })

      await factories.createPagePermission(
        parentPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      // Child page should not inherit parent permissions
      const childAccess = await getUserAccessLevel(otherUser.id, childPage.id)
      expect(childAccess).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('handles permission checks for trashed pages', async () => {
      const trashedPage = await factories.createPage(testDrive.id, {
        isTrashed: true,
        trashedAt: new Date()
      })

      await factories.createPagePermission(
        trashedPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const access = await getUserAccessLevel(otherUser.id, trashedPage.id)
      expect(access).not.toBeNull()
      expect(access?.canView).toBe(true)
    })

    it('handles permission checks for different page types', async () => {
      const aiChatPage = await factories.createPage(testDrive.id, {
        type: 'AI_CHAT',
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-sonnet'
      })

      await factories.createPagePermission(
        aiChatPage.id,
        otherUser.id,
        { canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: testUser.id }
      )

      const access = await getUserAccessLevel(otherUser.id, aiChatPage.id)
      expect(access).not.toBeNull()
      expect(access?.canView).toBe(true)
    })
  })
})