import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getUnreadCount
} from '../notifications'
import { db, sql, notifications } from '@pagespace/db'
import { factories } from '@pagespace/db/test/factories'

// Mock fetch for broadcast testing
global.fetch = vi.fn()

describe('notifications', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let otherUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    // Clean up test data before each test
    // Use TRUNCATE CASCADE for atomic cleanup (safer than individual DELETEs)
    await db.execute(sql`TRUNCATE TABLE users CASCADE`)

    testUser = await factories.createUser()
    otherUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)

    // Reset fetch mock
    vi.clearAllMocks()
    ;(global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('createNotification', () => {
    it('creates a notification successfully', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Permission Granted',
        message: 'You have been granted access to a page',
        pageId: testPage.id,
        triggeredByUserId: otherUser.id
      })

      expect(notification).toBeTruthy()
      expect(notification.id).toBeTruthy()
      expect(notification.userId).toBe(testUser.id)
      expect(notification.type).toBe('PERMISSION_GRANTED')
      expect(notification.title).toBe('Permission Granted')
      expect(notification.message).toBe('You have been granted access to a page')
      expect(notification.isRead).toBe(false)
    })

    it('creates notification with metadata', async () => {
      const metadata = { permissionLevel: 'edit', pageTitle: 'Test Page' }

      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Permission Granted',
        message: 'Test message',
        metadata
      })

      expect(notification.metadata).toEqual(metadata)
    })

    it('creates notification with drive reference', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'DRIVE_INVITED',
        title: 'Drive Invitation',
        message: 'You have been invited to a drive',
        driveId: testDrive.id,
        triggeredByUserId: otherUser.id
      })

      expect(notification.driveId).toBe(testDrive.id)
    })

    it('creates notification with page reference', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PAGE_SHARED',
        title: 'Page Shared',
        message: 'A page has been shared with you',
        pageId: testPage.id,
        triggeredByUserId: otherUser.id
      })

      expect(notification.pageId).toBe(testPage.id)
    })

    it('broadcasts notification via Socket.IO', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Test message'
      })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/broadcast'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining(`notifications:${testUser.id}`)
        })
      )
    })

    it('handles broadcast failure gracefully', async () => {
      ;(global.fetch as any).mockRejectedValue(new Error('Network error'))

      // Should not throw even if broadcast fails
      await expect(
        createNotification({
          userId: testUser.id,
          type: 'PERMISSION_GRANTED',
          title: 'Test',
          message: 'Test message'
        })
      ).resolves.toBeTruthy()
    })

    it('creates notification without optional fields', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'CONNECTION_REQUEST',
        title: 'Connection Request',
        message: 'Someone wants to connect'
      })

      expect(notification.pageId).toBeNull()
      expect(notification.driveId).toBeNull()
      expect(notification.triggeredByUserId).toBeNull()
      expect(notification.metadata).toBeNull()
    })

    it('sets createdAt timestamp', async () => {
      const beforeTime = new Date()

      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Test message'
      })

      const afterTime = new Date()

      expect(notification.createdAt).toBeInstanceOf(Date)
      expect(notification.createdAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime())
      expect(notification.createdAt.getTime()).toBeLessThanOrEqual(afterTime.getTime())
    })
  })

  describe('getUserNotifications', () => {
    it('retrieves user notifications', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Notification 1',
        message: 'Message 1'
      })

      await createNotification({
        userId: testUser.id,
        type: 'PAGE_SHARED',
        title: 'Notification 2',
        message: 'Message 2'
      })

      const result = await getUserNotifications(testUser.id)

      expect(result).toHaveLength(2)
      expect(result[0].title).toBe('Notification 2') // Most recent first
      expect(result[1].title).toBe('Notification 1')
    })

    it('returns notifications with triggered by user info', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Test message',
        triggeredByUserId: otherUser.id
      })

      const result = await getUserNotifications(testUser.id)

      expect(result[0].triggeredByUser).toBeTruthy()
      expect(result[0].triggeredByUser?.id).toBe(otherUser.id)
      expect(result[0].triggeredByUser?.name).toBe(otherUser.name)
      expect(result[0].triggeredByUser?.email).toBe(otherUser.email)
    })

    it('returns notifications with drive info', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'DRIVE_INVITED',
        title: 'Drive Invite',
        message: 'Test message',
        driveId: testDrive.id
      })

      const result = await getUserNotifications(testUser.id)

      expect(result[0].drive).toBeTruthy()
      expect(result[0].drive?.id).toBe(testDrive.id)
      expect(result[0].drive?.name).toBe(testDrive.name)
    })

    it('does not return other users notifications', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'For testUser',
        message: 'Message'
      })

      await createNotification({
        userId: otherUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'For otherUser',
        message: 'Message'
      })

      const result = await getUserNotifications(testUser.id)

      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('For testUser')
    })

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await createNotification({
          userId: testUser.id,
          type: 'PERMISSION_GRANTED',
          title: `Notification ${i}`,
          message: 'Message'
        })
      }

      const result = await getUserNotifications(testUser.id, 5)

      expect(result).toHaveLength(5)
    })

    it('returns empty array for user with no notifications', async () => {
      const result = await getUserNotifications(testUser.id)

      expect(result).toEqual([])
    })

    it('orders notifications by createdAt DESC (newest first)', async () => {
      const notif1 = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'First',
        message: 'Message'
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      const notif2 = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Second',
        message: 'Message'
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      const notif3 = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Third',
        message: 'Message'
      })

      const result = await getUserNotifications(testUser.id)

      expect(result[0].title).toBe('Third')
      expect(result[1].title).toBe('Second')
      expect(result[2].title).toBe('First')
    })
  })

  describe('markNotificationAsRead', () => {
    it('marks notification as read', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Message'
      })

      await markNotificationAsRead(notification.id, testUser.id)

      const result = await getUserNotifications(testUser.id)
      expect(result[0].isRead).toBe(true)
    })

    it('sets readAt timestamp', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Message'
      })

      const beforeTime = new Date()
      await markNotificationAsRead(notification.id, testUser.id)
      const afterTime = new Date()

      const result = await getUserNotifications(testUser.id)
      const readAt = result[0].readAt

      expect(readAt).toBeInstanceOf(Date)
      expect(readAt!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime())
      expect(readAt!.getTime()).toBeLessThanOrEqual(afterTime.getTime())
    })

    it('does not mark other users notification as read', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Message'
      })

      await markNotificationAsRead(notification.id, otherUser.id)

      const result = await getUserNotifications(testUser.id)
      expect(result[0].isRead).toBe(false)
    })

    it('handles non-existent notification gracefully', async () => {
      await expect(
        markNotificationAsRead('nonexistent', testUser.id)
      ).resolves.not.toThrow()
    })
  })

  describe('markAllNotificationsAsRead', () => {
    it('marks all user notifications as read', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Notif 1',
        message: 'Message'
      })

      await createNotification({
        userId: testUser.id,
        type: 'PAGE_SHARED',
        title: 'Notif 2',
        message: 'Message'
      })

      await createNotification({
        userId: testUser.id,
        type: 'DRIVE_INVITED',
        title: 'Notif 3',
        message: 'Message'
      })

      await markAllNotificationsAsRead(testUser.id)

      const result = await getUserNotifications(testUser.id)

      expect(result.every(r => r.isRead)).toBe(true)
    })

    it('does not affect other users notifications', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'For testUser',
        message: 'Message'
      })

      await createNotification({
        userId: otherUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'For otherUser',
        message: 'Message'
      })

      await markAllNotificationsAsRead(testUser.id)

      const testUserNotifs = await getUserNotifications(testUser.id)
      const otherUserNotifs = await getUserNotifications(otherUser.id)

      expect(testUserNotifs[0].isRead).toBe(true)
      expect(otherUserNotifs[0].isRead).toBe(false)
    })

    it('handles user with no notifications', async () => {
      await expect(
        markAllNotificationsAsRead(testUser.id)
      ).resolves.not.toThrow()
    })
  })

  describe('deleteNotification', () => {
    it('deletes notification', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Message'
      })

      await deleteNotification(notification.id, testUser.id)

      const result = await getUserNotifications(testUser.id)
      expect(result).toHaveLength(0)
    })

    it('does not delete other users notification', async () => {
      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Message'
      })

      await deleteNotification(notification.id, otherUser.id)

      const result = await getUserNotifications(testUser.id)
      expect(result).toHaveLength(1)
    })

    it('handles non-existent notification gracefully', async () => {
      await expect(
        deleteNotification('nonexistent', testUser.id)
      ).resolves.not.toThrow()
    })
  })

  describe('getUnreadCount', () => {
    it('returns count of unread notifications', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Unread 1',
        message: 'Message'
      })

      await createNotification({
        userId: testUser.id,
        type: 'PAGE_SHARED',
        title: 'Unread 2',
        message: 'Message'
      })

      const notif3 = await createNotification({
        userId: testUser.id,
        type: 'DRIVE_INVITED',
        title: 'Read',
        message: 'Message'
      })

      await markNotificationAsRead(notif3.id, testUser.id)

      const count = await getUnreadCount(testUser.id)
      expect(count).toBe(2)
    })

    it('returns 0 for user with no unread notifications', async () => {
      const notif = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Read',
        message: 'Message'
      })

      await markNotificationAsRead(notif.id, testUser.id)

      const count = await getUnreadCount(testUser.id)
      expect(count).toBe(0)
    })

    it('returns 0 for user with no notifications', async () => {
      const count = await getUnreadCount(testUser.id)
      expect(count).toBe(0)
    })

    it('does not count other users notifications', async () => {
      await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'For testUser',
        message: 'Message'
      })

      await createNotification({
        userId: otherUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'For otherUser',
        message: 'Message'
      })

      const count = await getUnreadCount(testUser.id)
      expect(count).toBe(1)
    })
  })

  describe('notification types', () => {
    const notificationTypes: Array<{
      type: 'PERMISSION_GRANTED' | 'PERMISSION_REVOKED' | 'PERMISSION_UPDATED' | 'PAGE_SHARED' | 'DRIVE_INVITED' | 'DRIVE_JOINED' | 'DRIVE_ROLE_CHANGED' | 'CONNECTION_REQUEST' | 'CONNECTION_ACCEPTED' | 'CONNECTION_REJECTED' | 'NEW_DIRECT_MESSAGE'
      title: string
    }> = [
      { type: 'PERMISSION_GRANTED', title: 'Permission Granted' },
      { type: 'PERMISSION_REVOKED', title: 'Permission Revoked' },
      { type: 'PERMISSION_UPDATED', title: 'Permission Updated' },
      { type: 'PAGE_SHARED', title: 'Page Shared' },
      { type: 'DRIVE_INVITED', title: 'Drive Invited' },
      { type: 'DRIVE_JOINED', title: 'Drive Joined' },
      { type: 'DRIVE_ROLE_CHANGED', title: 'Role Changed' },
      { type: 'CONNECTION_REQUEST', title: 'Connection Request' },
      { type: 'CONNECTION_ACCEPTED', title: 'Connection Accepted' },
      { type: 'CONNECTION_REJECTED', title: 'Connection Rejected' },
      { type: 'NEW_DIRECT_MESSAGE', title: 'New Message' }
    ]

    notificationTypes.forEach(({ type, title }) => {
      it(`creates ${type} notification`, async () => {
        const notification = await createNotification({
          userId: testUser.id,
          type,
          title,
          message: `Test ${type} message`
        })

        expect(notification.type).toBe(type)
        expect(notification.title).toBe(title)
      })
    })
  })

  describe('edge cases', () => {
    it('handles very long title', async () => {
      const longTitle = 'a'.repeat(1000)

      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: longTitle,
        message: 'Message'
      })

      expect(notification.title).toBe(longTitle)
    })

    it('handles very long message', async () => {
      const longMessage = 'a'.repeat(10000)

      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Title',
        message: longMessage
      })

      expect(notification.message).toBe(longMessage)
    })

    it('handles complex metadata', async () => {
      const complexMetadata = {
        nested: {
          deeply: {
            nested: {
              value: 'test'
            }
          }
        },
        array: [1, 2, 3, { key: 'value' }]
      }

      const notification = await createNotification({
        userId: testUser.id,
        type: 'PERMISSION_GRANTED',
        title: 'Test',
        message: 'Message',
        metadata: complexMetadata
      })

      expect(notification.metadata).toEqual(complexMetadata)
    })
  })
})
