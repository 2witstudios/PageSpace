import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getUserAccessLevel } from '../permissions/permissions-cached'
import { factories } from '@pagespace/db/test/factories'
import { db, users, pagePermissions, driveMembers, pages, drives } from '@pagespace/db'
import { PermissionCache } from '../services/permission-cache'

describe('cached permissions system', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    // Delete in foreign key order to avoid deadlocks from cascade contention
    await db.delete(pagePermissions)
    await db.delete(pages)
    await db.delete(driveMembers)
    await db.delete(drives)
    await db.delete(users)

    // Clear permission cache before each test
    await PermissionCache.getInstance().clearAll()

    testUser = await factories.createUser()
    otherUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  afterEach(async () => {
    // Clean up cache after each test
    await PermissionCache.getInstance().clearAll()
  })

  describe('getUserAccessLevel (cached)', () => {
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

    it('returns specific permissions when granted to non-admin user', async () => {
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

    it('caches admin permissions correctly', async () => {
      // Add otherUser as admin to the drive
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' })

      // First call - cache miss
      const access1 = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access1).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })

      // Second call - should hit cache
      const access2 = await getUserAccessLevel(otherUser.id, testPage.id)
      expect(access2).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })
    })

    it('bypasses cache when bypassCache option is true', async () => {
      // Add otherUser as admin to the drive
      await factories.createDriveMember(testDrive.id, otherUser.id, { role: 'ADMIN' })

      // First call
      await getUserAccessLevel(otherUser.id, testPage.id)

      // Second call with bypass
      const access = await getUserAccessLevel(otherUser.id, testPage.id, { bypassCache: true })
      expect(access).toEqual({
        canView: true,
        canEdit: true,
        canShare: true,
        canDelete: true,
      })
    })
  })
})
