/**
 * Unit tests for audit event queries
 *
 * Tests the query-audit-events module which provides high-level audit trail queries.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import {
  getAuditEvents,
  getDriveActivityFeed,
  getUserActivityTimeline,
  getEntityHistory,
  getDriveAiActivity,
  getDriveHumanActivity,
  getOperationEvents,
  getMultiDriveActivity,
  getDriveActivityByDateRange,
  getDriveActivityStats,
  searchAuditEvents,
  getLatestEntityEvent,
  getEventsByActionType,
  getPageAuditEvents,
  getPagePermissionEvents,
} from '../audit/query-audit-events'
import { createAuditEvent } from '../audit/create-audit-event'
import { factories } from '@pagespace/db/test/factories'
import { db, users } from '@pagespace/db'

describe('getAuditEvents', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with no filters', async () => {
    const given = 'no filter criteria'
    const should = 'return all audit events'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getAuditEvents()

    expect(actual.length).toBeGreaterThanOrEqual(2)
  })

  test('with driveId filter', async () => {
    const given = 'filter by drive ID'
    const should = 'return only events for that drive'

    const otherDrive = await factories.createDrive(testUser.id)

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: 'other-page',
      userId: testUser.id,
      driveId: otherDrive.id,
    })

    const actual = await getAuditEvents({ driveId: testDrive.id })

    expect(actual.every(e => e.driveId === testDrive.id)).toBe(true)
  })

  test('with userId filter', async () => {
    const given = 'filter by user ID'
    const should = 'return only events by that user'

    const otherUser = await factories.createUser()

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: otherUser.id,
      driveId: testDrive.id,
    })

    const actual = await getAuditEvents({ userId: testUser.id })

    expect(actual.every(e => e.userId === testUser.id)).toBe(true)
  })

  test('with entityType and entityId filters', async () => {
    const given = 'filter by entity type and ID'
    const should = 'return only events for that specific entity'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'DRIVE_CREATE',
      entityType: 'DRIVE',
      entityId: testDrive.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getAuditEvents({
      entityType: 'PAGE',
      entityId: testPage.id,
    })

    expect(actual.every(e => e.entityType === 'PAGE' && e.entityId === testPage.id)).toBe(true)
  })

  test('with actionType filter', async () => {
    const given = 'filter by action type'
    const should = 'return only events with that action type'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getAuditEvents({ actionType: 'PAGE_UPDATE' })

    expect(actual.every(e => e.actionType === 'PAGE_UPDATE')).toBe(true)
  })

  test('with isAiAction filter', async () => {
    const given = 'filter by AI action flag'
    const should = 'return only AI or human events based on flag'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    const actual = await getAuditEvents({ isAiAction: true })

    expect(actual.every(e => e.isAiAction === true)).toBe(true)
  })

  test('with date range filter', async () => {
    const given = 'filter by start and end date'
    const should = 'return only events within date range'

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getAuditEvents({
      startDate: yesterday,
      endDate: tomorrow,
    })

    expect(actual.length).toBeGreaterThan(0)
    expect(actual.every(e => {
      const eventDate = new Date(e.createdAt)
      return eventDate >= yesterday && eventDate <= tomorrow
    })).toBe(true)
  })

  test('with operationId filter', async () => {
    const given = 'filter by operation ID'
    const should = 'return only events in that operation'

    const operationId = 'op-123'

    await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      operationId,
    })

    await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: 'other-page',
      userId: testUser.id,
      driveId: testDrive.id,
      operationId,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getAuditEvents({ operationId })

    expect(actual).toHaveLength(2)
    expect(actual.every(e => e.operationId === operationId)).toBe(true)
  })

  test('with limit parameter', async () => {
    const given = 'many events with limit'
    const should = 'return only limited number of events'

    for (let i = 0; i < 10; i++) {
      await createAuditEvent({
        actionType: 'PAGE_UPDATE',
        entityType: 'PAGE',
        entityId: testPage.id,
        userId: testUser.id,
        driveId: testDrive.id,
      })
    }

    const actual = await getAuditEvents({ driveId: testDrive.id }, 5)

    expect(actual).toHaveLength(5)
  })

  test('with multiple combined filters', async () => {
    const given = 'multiple filter criteria combined'
    const should = 'return only events matching all filters'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    const actual = await getAuditEvents({
      driveId: testDrive.id,
      entityType: 'PAGE',
      isAiAction: true,
    })

    expect(actual.every(e =>
      e.driveId === testDrive.id &&
      e.entityType === 'PAGE' &&
      e.isAiAction === true
    )).toBe(true)
  })
})

describe('getDriveActivityFeed', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with drive events', async () => {
    const given = 'drive with multiple events'
    const should = 'return activity feed for that drive'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getDriveActivityFeed(testDrive.id)

    expect(actual.length).toBeGreaterThanOrEqual(2)
    expect(actual.every(e => e.driveId === testDrive.id)).toBe(true)
  })
})

describe('getUserActivityTimeline', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with user events', async () => {
    const given = 'user with multiple events'
    const should = 'return activity timeline for that user'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getUserActivityTimeline(testUser.id)

    expect(actual.length).toBeGreaterThanOrEqual(2)
    expect(actual.every(e => e.userId === testUser.id)).toBe(true)
  })
})

describe('getEntityHistory', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with page history', async () => {
    const given = 'page with multiple events'
    const should = 'return history for that page'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getEntityHistory('PAGE', testPage.id)

    expect(actual.length).toBeGreaterThanOrEqual(2)
    expect(actual.every(e => e.entityType === 'PAGE' && e.entityId === testPage.id)).toBe(true)
  })
})

describe('getDriveAiActivity', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with mixed AI and human events', async () => {
    const given = 'drive with AI and human events'
    const should = 'return only AI events'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    const actual = await getDriveAiActivity(testDrive.id)

    expect(actual.every(e => e.isAiAction === true)).toBe(true)
  })
})

describe('getDriveHumanActivity', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with mixed AI and human events', async () => {
    const given = 'drive with AI and human events'
    const should = 'return only human events'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    const actual = await getDriveHumanActivity(testDrive.id)

    expect(actual.every(e => e.isAiAction === false)).toBe(true)
  })
})

describe('getOperationEvents', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with grouped operation', async () => {
    const given = 'multiple events with same operation ID'
    const should = 'return all events in that operation'

    const operationId = 'bulk-op-123'

    await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: 'page-1',
      userId: testUser.id,
      driveId: testDrive.id,
      operationId,
    })

    await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: 'page-2',
      userId: testUser.id,
      driveId: testDrive.id,
      operationId,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: 'page-3',
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getOperationEvents(operationId)

    expect(actual).toHaveLength(2)
    expect(actual.every(e => e.operationId === operationId)).toBe(true)
  })
})

describe('getMultiDriveActivity', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let drive1: Awaited<ReturnType<typeof factories.createDrive>>
  let drive2: Awaited<ReturnType<typeof factories.createDrive>>
  let page1: Awaited<ReturnType<typeof factories.createPage>>
  let page2: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    drive1 = await factories.createDrive(testUser.id)
    drive2 = await factories.createDrive(testUser.id)
    page1 = await factories.createPage(drive1.id)
    page2 = await factories.createPage(drive2.id)
  })

  test('with multiple drives', async () => {
    const given = 'activity across multiple drives'
    const should = 'return events from all specified drives'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: page1.id,
      userId: testUser.id,
      driveId: drive1.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: page2.id,
      userId: testUser.id,
      driveId: drive2.id,
    })

    const actual = await getMultiDriveActivity([drive1.id, drive2.id])

    expect(actual.length).toBeGreaterThanOrEqual(2)
    const driveIds = new Set(actual.map(e => e.driveId))
    expect(driveIds.has(drive1.id)).toBe(true)
    expect(driveIds.has(drive2.id)).toBe(true)
  })

  test('with empty drive list', async () => {
    const given = 'empty array of drive IDs'
    const should = 'return empty array'

    const actual = await getMultiDriveActivity([])

    expect(actual).toEqual([])
  })
})

describe('getDriveActivityByDateRange', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with date range', async () => {
    const given = 'events within specific date range'
    const should = 'return only events in that range'

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getDriveActivityByDateRange(
      testDrive.id,
      yesterday,
      tomorrow
    )

    expect(actual.length).toBeGreaterThan(0)
    expect(actual.every(e => {
      const eventDate = new Date(e.createdAt)
      return eventDate >= yesterday && eventDate <= tomorrow
    })).toBe(true)
  })
})

describe('getDriveActivityStats', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with mixed activity', async () => {
    const given = 'drive with AI and human activity'
    const should = 'calculate statistics correctly'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: true,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
    })

    const actual = await getDriveActivityStats(testDrive.id, 30)

    expect(actual.total).toBe(3)
    expect(actual.aiActions).toBe(1)
    expect(actual.humanActions).toBe(2)
    expect(actual.aiPercentage).toBeCloseTo(33.33, 1)
    expect(actual.uniqueUsers).toBe(1)
    expect(actual.actionTypeCounts['PAGE_CREATE']).toBe(1)
    expect(actual.actionTypeCounts['PAGE_UPDATE']).toBe(2)
  })
})

describe('searchAuditEvents', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with description search', async () => {
    const given = 'search term matching description'
    const should = 'return matching events'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      description: 'Updated page content with new information',
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      description: 'Changed page title',
    })

    const actual = await searchAuditEvents(testDrive.id, 'content')

    expect(actual.some(e => e.description?.includes('content'))).toBe(true)
  })

  test('with reason search', async () => {
    const given = 'search term matching reason'
    const should = 'return matching events'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      reason: 'User requested content improvement',
    })

    const actual = await searchAuditEvents(testDrive.id, 'improvement')

    expect(actual.some(e => e.reason?.includes('improvement'))).toBe(true)
  })

  test('with case-insensitive search', async () => {
    const given = 'search term in different case'
    const should = 'match case-insensitively'

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      description: 'Updated Page Content',
    })

    const actual = await searchAuditEvents(testDrive.id, 'page')

    expect(actual.length).toBeGreaterThan(0)
  })
})

describe('getLatestEntityEvent', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with multiple events', async () => {
    const given = 'entity with multiple events'
    const should = 'return most recent event'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const latest = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getLatestEntityEvent('PAGE', testPage.id)

    expect(actual?.id).toBe(latest.id)
  })
})

describe('getEventsByActionType', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with specific action type', async () => {
    const given = 'filter by specific action type'
    const should = 'return only events of that type'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getEventsByActionType(testDrive.id, 'PAGE_CREATE')

    expect(actual.every(e => e.actionType === 'PAGE_CREATE')).toBe(true)
  })
})

describe('getPageAuditEvents', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with page events', async () => {
    const given = 'page with multiple events'
    const should = 'return all events for that page'

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getPageAuditEvents(testPage.id)

    expect(actual.length).toBeGreaterThanOrEqual(2)
    expect(actual.every(e => e.entityType === 'PAGE' && e.entityId === testPage.id)).toBe(true)
  })
})

describe('getPagePermissionEvents', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with permission events', async () => {
    const given = 'page with permission grant and revoke events'
    const should = 'return only permission-related events'

    await createAuditEvent({
      actionType: 'PERMISSION_GRANT',
      entityType: 'PERMISSION',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    await createAuditEvent({
      actionType: 'PERMISSION_REVOKE',
      entityType: 'PERMISSION',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await getPagePermissionEvents(testPage.id)

    expect(actual).toHaveLength(2)
    expect(actual.every(e =>
      ['PERMISSION_GRANT', 'PERMISSION_REVOKE', 'PERMISSION_UPDATE'].includes(e.actionType)
    )).toBe(true)
  })
})
