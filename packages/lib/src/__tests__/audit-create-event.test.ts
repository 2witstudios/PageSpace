/**
 * Unit tests for audit event creation
 *
 * Tests the create-audit-event module which provides core audit trail functionality.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import {
  createAuditEvent,
  createBulkAuditEvents,
  computeChanges,
} from '../audit/create-audit-event'
import { factories } from '@pagespace/db/test/factories'
import { db, auditEvents, users } from '@pagespace/db'

describe('createAuditEvent', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>
  let testPage: Awaited<ReturnType<typeof factories.createPage>>

  beforeEach(async () => {
    // Clean up test data
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
    testPage = await factories.createPage(testDrive.id)
  })

  test('with valid page update action', async () => {
    const given = 'valid page update action with user attribution'
    const should = 'create audit event with all provided fields'

    const actual = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      description: 'Updated page content',
      reason: 'User edited the page',
    })

    expect(actual).toMatchObject({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      isAiAction: false,
      description: 'Updated page content',
      reason: 'User edited the page',
    })
    expect(actual.id).toBeTruthy()
    expect(actual.createdAt).toBeInstanceOf(Date)
  })

  test('with before and after states', async () => {
    const given = 'audit event with before and after states'
    const should = 'store both states in JSONB fields'

    const beforeState = { title: 'Old Title', content: 'Old content' }
    const afterState = { title: 'New Title', content: 'New content' }

    const actual = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      beforeState,
      afterState,
    })

    expect(actual.beforeState).toEqual(beforeState)
    expect(actual.afterState).toEqual(afterState)
  })

  test('with changes object', async () => {
    const given = 'audit event with specific field changes'
    const should = 'store changes with before/after values'

    const changes = {
      title: { before: 'Old', after: 'New' },
      content: { before: 'Old content', after: 'New content' },
    }

    const actual = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      changes,
    })

    expect(actual.changes).toEqual(changes)
  })

  test('with AI action attribution', async () => {
    const given = 'AI-initiated action with operation ID'
    const should = 'mark as AI action and link to AI operation'

    const aiOperationId = 'ai-op-123'

    const actual = await createAuditEvent({
      actionType: 'AI_EDIT',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      isAiAction: true,
      aiOperationId,
      driveId: testDrive.id,
      description: 'AI edited page content',
    })

    expect(actual.isAiAction).toBe(true)
    expect(actual.aiOperationId).toBe(aiOperationId)
  })

  test('with request context metadata', async () => {
    const given = 'audit event with request context (IP, user agent, session)'
    const should = 'store all request context fields'

    const actual = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      requestId: 'req-123',
      sessionId: 'session-456',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
    })

    expect(actual.requestId).toBe('req-123')
    expect(actual.sessionId).toBe('session-456')
    expect(actual.ipAddress).toBe('192.168.1.1')
    expect(actual.userAgent).toBe('Mozilla/5.0')
  })

  test('with operation grouping', async () => {
    const given = 'multiple related events with same operation ID'
    const should = 'link events together via operation ID'

    const operationId = 'bulk-op-123'

    const event1 = await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      operationId,
    })

    const event2 = await createAuditEvent({
      actionType: 'PAGE_MOVE',
      entityType: 'PAGE',
      entityId: 'another-page',
      userId: testUser.id,
      driveId: testDrive.id,
      operationId,
    })

    expect(event1.operationId).toBe(operationId)
    expect(event2.operationId).toBe(operationId)
  })

  test('with parent event relationship', async () => {
    const given = 'child event with parent event reference'
    const should = 'create parent-child relationship'

    const parentEvent = await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
    })

    const actual = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      parentEventId: parentEvent.id,
    })

    expect(actual.parentEventId).toBe(parentEvent.id)
  })

  test('with custom metadata', async () => {
    const given = 'audit event with custom metadata object'
    const should = 'store metadata in JSONB field'

    const metadata = {
      customField: 'value',
      nestedData: { key: 'value' },
      arrayData: [1, 2, 3],
    }

    const actual = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: testPage.id,
      userId: testUser.id,
      driveId: testDrive.id,
      metadata,
    })

    expect(actual.metadata).toEqual(metadata)
  })

  test('with permission grant action', async () => {
    const given = 'permission grant audit event'
    const should = 'create event with permission entity type'

    const actual = await createAuditEvent({
      actionType: 'PERMISSION_GRANT',
      entityType: 'PERMISSION',
      entityId: 'perm-123',
      userId: testUser.id,
      driveId: testDrive.id,
      afterState: {
        pageId: testPage.id,
        userId: 'other-user',
        canView: true,
        canEdit: true,
      },
    })

    expect(actual.actionType).toBe('PERMISSION_GRANT')
    expect(actual.entityType).toBe('PERMISSION')
  })

  test('with drive creation action', async () => {
    const given = 'drive creation audit event'
    const should = 'create event with drive entity type'

    const actual = await createAuditEvent({
      actionType: 'DRIVE_CREATE',
      entityType: 'DRIVE',
      entityId: testDrive.id,
      userId: testUser.id,
      driveId: testDrive.id,
      afterState: {
        name: testDrive.name,
        ownerId: testUser.id,
      },
    })

    expect(actual.actionType).toBe('DRIVE_CREATE')
    expect(actual.entityType).toBe('DRIVE')
  })
})

describe('createBulkAuditEvents', () => {
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)
  })

  test('with multiple related events', async () => {
    const given = 'array of related audit events'
    const should = 'create all events in single transaction'

    const operationId = 'bulk-op-123'
    const events = [
      {
        actionType: 'PAGE_MOVE' as const,
        entityType: 'PAGE' as const,
        entityId: 'page-1',
        userId: testUser.id,
        driveId: testDrive.id,
        operationId,
      },
      {
        actionType: 'PAGE_MOVE' as const,
        entityType: 'PAGE' as const,
        entityId: 'page-2',
        userId: testUser.id,
        driveId: testDrive.id,
        operationId,
      },
      {
        actionType: 'PAGE_MOVE' as const,
        entityType: 'PAGE' as const,
        entityId: 'page-3',
        userId: testUser.id,
        driveId: testDrive.id,
        operationId,
      },
    ]

    const actual = await createBulkAuditEvents(events)

    expect(actual).toHaveLength(3)
    expect(actual[0].operationId).toBe(operationId)
    expect(actual[1].operationId).toBe(operationId)
    expect(actual[2].operationId).toBe(operationId)
  })

  test('with empty array', async () => {
    const given = 'empty array of events'
    const should = 'return empty array without errors'

    const actual = await createBulkAuditEvents([])

    expect(actual).toEqual([])
  })

  test('with mixed action types', async () => {
    const given = 'bulk events with different action types'
    const should = 'create all events with correct types'

    const events = [
      {
        actionType: 'PAGE_CREATE' as const,
        entityType: 'PAGE' as const,
        entityId: 'page-1',
        userId: testUser.id,
        driveId: testDrive.id,
      },
      {
        actionType: 'PERMISSION_GRANT' as const,
        entityType: 'PERMISSION' as const,
        entityId: 'perm-1',
        userId: testUser.id,
        driveId: testDrive.id,
      },
    ]

    const actual = await createBulkAuditEvents(events)

    expect(actual[0].actionType).toBe('PAGE_CREATE')
    expect(actual[1].actionType).toBe('PERMISSION_GRANT')
  })
})

describe('computeChanges', () => {
  test('with changed fields', () => {
    const given = 'before and after states with changed fields'
    const should = 'return changes object with before/after values'

    const before = { title: 'Old', content: 'Old content', position: 1 }
    const after = { title: 'New', content: 'Old content', position: 2 }

    const actual = computeChanges(before, after)

    const expected = {
      title: { before: 'Old', after: 'New' },
      position: { before: 1, after: 2 },
    }

    expect(actual).toEqual(expected)
  })

  test('with no changes', () => {
    const given = 'identical before and after states'
    const should = 'return empty changes object'

    const before = { title: 'Same', content: 'Same content' }
    const after = { title: 'Same', content: 'Same content' }

    const actual = computeChanges(before, after)

    expect(actual).toEqual({})
  })

  test('with added fields', () => {
    const given = 'after state with new fields not in before state'
    const should = 'include new fields with null before value'

    const before = { title: 'Title' }
    const after = { title: 'Title', content: 'New content' }

    const actual = computeChanges(before, after)

    expect(actual).toEqual({
      content: { before: undefined, after: 'New content' },
    })
  })

  test('with removed fields', () => {
    const given = 'before state with fields not in after state'
    const should = 'include removed fields with null after value'

    const before = { title: 'Title', content: 'Content' }
    const after = { title: 'Title' }

    const actual = computeChanges(before, after)

    expect(actual).toEqual({
      content: { before: 'Content', after: null },
    })
  })

  test('with nested objects', () => {
    const given = 'before and after states with nested objects'
    const should = 'detect changes in nested structures'

    const before = { user: { name: 'Old' } }
    const after = { user: { name: 'New' } }

    const actual = computeChanges(before, after)

    expect(actual).toEqual({
      user: {
        before: { name: 'Old' },
        after: { name: 'New' },
      },
    })
  })

  test('with all fields changed', () => {
    const given = 'completely different before and after states'
    const should = 'return changes for all fields'

    const before = { a: 1, b: 2, c: 3 }
    const after = { a: 4, b: 5, c: 6 }

    const actual = computeChanges(before, after)

    expect(actual).toEqual({
      a: { before: 1, after: 4 },
      b: { before: 2, after: 5 },
      c: { before: 3, after: 6 },
    })
  })
})
