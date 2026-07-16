import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import type { ActivityLogForRollback } from '../../rollback-service';
import {
  planPageRollback,
  planDriveRollback,
  planPermissionRollback,
  planAgentRollback,
  planMemberRollback,
  planRoleRollback,
  planMessageRollback,
} from '../rollback-plans';

const NOW = new Date('2024-05-05T05:05:05.000Z');
const AGENT_FIELDS = ['systemPrompt', 'enabledTools'] as const;

function act(overrides: Partial<ActivityLogForRollback> = {}): ActivityLogForRollback {
  return {
    id: 'a', timestamp: NOW, userId: 'u', actorEmail: 'e', actorDisplayName: null,
    operation: 'update', resourceType: 'page', resourceId: 'res', resourceTitle: null,
    driveId: 'drive', pageId: 'page', isAiGenerated: false, aiProvider: null, aiModel: null,
    contentSnapshot: null, contentRef: null, contentFormat: null, contentSize: null,
    updatedFields: null, previousValues: null, newValues: null, metadata: null,
    streamId: null, streamSeq: null, changeGroupId: null, changeGroupType: null,
    stateHashBefore: null, stateHashAfter: null, rollbackFromActivityId: null,
    rollbackSourceOperation: null, rollbackSourceTimestamp: null, rollbackSourceTitle: null,
    ...overrides,
  };
}

function thrown(fn: () => unknown): string {
  try { fn(); return 'NO THROW'; } catch (e) { return (e as Error).message; }
}

describe('planPageRollback', () => {
  it('throws without a pageId', () => {
    assert({ given: 'no pageId', should: 'throw', actual: thrown(() => planPageRollback(act({ pageId: null }), null)), expected: 'Page ID not found in activity' });
  });
  it('plans trash-created for a create', () => {
    assert({ given: 'a create', should: 'plan trash-created', actual: planPageRollback(act({ operation: 'create' }), null), expected: { kind: 'trash-created' } });
  });
  it('restores updatedFields from previousValues', () => {
    assert({
      given: 'updatedFields listing the fields to restore',
      should: 'restore only those from previousValues',
      actual: planPageRollback(act({ operation: 'update', updatedFields: ['title'], previousValues: { title: 'old', ignored: 1 } }), null),
      expected: { kind: 'apply-update', updateData: { title: 'old' }, restoreOrphanedChildren: false },
    });
  });
  it('restores all previousValues when no updatedFields', () => {
    assert({
      given: 'no updatedFields but previousValues present',
      should: 'restore all previousValues',
      actual: planPageRollback(act({ operation: 'update', updatedFields: null, previousValues: { title: 'old', position: 2 } }), null),
      expected: { kind: 'apply-update', updateData: { title: 'old', position: 2 }, restoreOrphanedChildren: false },
    });
  });
  it('injects the content snapshot on an update', () => {
    assert({
      given: 'an update with a resolved content snapshot',
      should: 'inject content',
      actual: planPageRollback(act({ operation: 'update', updatedFields: ['title'], previousValues: { title: 'old' } }), 'SNAP'),
      expected: { kind: 'apply-update', updateData: { title: 'old', content: 'SNAP' }, restoreOrphanedChildren: false },
    });
  });
  it('does not inject snapshot for a non-update operation', () => {
    assert({
      given: 'a trash operation with a snapshot',
      should: 'not inject content',
      actual: planPageRollback(act({ operation: 'trash', previousValues: { isTrashed: true } }), 'SNAP'),
      expected: { kind: 'apply-update', updateData: { isTrashed: true }, restoreOrphanedChildren: false },
    });
  });
  it('flags restoreOrphanedChildren when un-trashing', () => {
    const plan = planPageRollback(act({ operation: 'update', previousValues: { isTrashed: false } }), null);
    assert({
      given: 'an update restoring isTrashed to false',
      should: 'flag restoreOrphanedChildren',
      actual: plan.kind === 'apply-update' ? plan.restoreOrphanedChildren : null,
      expected: true,
    });
  });
  it('throws when there is nothing to restore', () => {
    assert({ given: 'no updatedFields and empty previousValues', should: 'throw', actual: thrown(() => planPageRollback(act({ operation: 'update', previousValues: {} }), null)), expected: 'No values to restore' });
  });
});

describe('planDriveRollback', () => {
  it('throws without a driveId', () => {
    assert({ given: 'no driveId', should: 'throw', actual: thrown(() => planDriveRollback(act({ driveId: null }))), expected: 'Drive ID not found in activity' });
  });
  it('plans trash-created for a create', () => {
    assert({ given: 'a create', should: 'plan trash-created', actual: planDriveRollback(act({ operation: 'create' })), expected: { kind: 'trash-created' } });
  });
  it('restores updatedFields', () => {
    assert({ given: 'updatedFields', should: 'restore listed fields', actual: planDriveRollback(act({ operation: 'update', updatedFields: ['name'], previousValues: { name: 'old' } })), expected: { kind: 'apply-update', updateData: { name: 'old' } } });
  });
  it('restores all previousValues when no updatedFields', () => {
    assert({ given: 'no updatedFields', should: 'restore all previousValues', actual: planDriveRollback(act({ operation: 'update', previousValues: { name: 'old' } })), expected: { kind: 'apply-update', updateData: { name: 'old' } } });
  });
  it('throws when nothing to restore', () => {
    assert({ given: 'empty previousValues', should: 'throw', actual: thrown(() => planDriveRollback(act({ operation: 'update', previousValues: {} }))), expected: 'No values to restore' });
  });
});

describe('planPermissionRollback', () => {
  it('throws without a pageId', () => {
    assert({ given: 'no pageId', should: 'throw', actual: thrown(() => planPermissionRollback(act({ pageId: null }))), expected: 'Page ID not found in activity' });
  });
  it('throws without a target user', () => {
    assert({ given: 'no target user', should: 'throw', actual: thrown(() => planPermissionRollback(act({ operation: 'permission_grant', metadata: null, previousValues: null }))), expected: 'Target user ID not found in activity' });
  });
  it('deletes on grant rollback (target from metadata)', () => {
    assert({ given: 'a grant with metadata targetUserId', should: 'plan a delete', actual: planPermissionRollback(act({ operation: 'permission_grant', metadata: { targetUserId: 'u9' } })), expected: { op: 'delete', pageId: 'page', userId: 'u9' } });
  });
  it('re-inserts on revoke rollback (target from previousValues, defaults applied)', () => {
    assert({
      given: 'a revoke with previousValues carrying userId and some flags',
      should: 'plan an insert defaulting missing flags to false',
      actual: planPermissionRollback(act({ operation: 'permission_revoke', metadata: null, previousValues: { userId: 'u3', canView: true, grantedBy: 'g', note: 'n' } })),
      expected: { op: 'insert', values: { pageId: 'page', userId: 'u3', canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: 'g', note: 'n' } },
    });
  });
  it('updates on permission_update rollback', () => {
    assert({ given: 'a permission_update', should: 'plan an update with restored fields', actual: planPermissionRollback(act({ operation: 'permission_update', metadata: { targetUserId: 'u3' }, previousValues: { canEdit: true } })), expected: { op: 'update', pageId: 'page', userId: 'u3', set: { canEdit: true } } });
  });
  it('throws on permission_update with no restorable values', () => {
    assert({ given: 'a permission_update with no known fields', should: 'throw', actual: thrown(() => planPermissionRollback(act({ operation: 'permission_update', metadata: { targetUserId: 'u3' }, previousValues: { unrelated: 1 } }))), expected: 'No permission values to restore' });
  });
  it('throws on an unsupported operation', () => {
    assert({ given: 'an unsupported permission operation', should: 'throw', actual: thrown(() => planPermissionRollback(act({ operation: 'weird', metadata: { targetUserId: 'u3' } }))), expected: 'Unsupported permission operation: weird' });
  });
});

describe('planAgentRollback', () => {
  it('throws without a pageId', () => {
    assert({ given: 'no pageId', should: 'throw', actual: thrown(() => planAgentRollback(act({ pageId: null }), AGENT_FIELDS)), expected: 'Page ID not found in activity' });
  });
  it('restores whitelisted fields', () => {
    assert({ given: 'previousValues with a whitelisted field', should: 'restore it', actual: planAgentRollback(act({ previousValues: { systemPrompt: 'old', other: 1 } }), AGENT_FIELDS), expected: { updateData: { systemPrompt: 'old' } } });
  });
  it('throws with no restorable config', () => {
    assert({ given: 'previousValues with nothing whitelisted', should: 'throw', actual: thrown(() => planAgentRollback(act({ previousValues: { other: 1 } }), AGENT_FIELDS)), expected: 'No agent config values to restore' });
  });
});

describe('planMemberRollback', () => {
  it('throws without a driveId', () => {
    assert({ given: 'no driveId', should: 'throw', actual: thrown(() => planMemberRollback(act({ driveId: null }), NOW)), expected: 'Drive ID not found in activity' });
  });
  it('throws without a target user', () => {
    assert({ given: 'no target user', should: 'throw', actual: thrown(() => planMemberRollback(act({ operation: 'member_add', metadata: null, previousValues: null }), NOW)), expected: 'Target user ID not found in activity' });
  });
  it('removes a member that was added', () => {
    assert({ given: 'a member_add', should: 'plan a delete', actual: planMemberRollback(act({ operation: 'member_add', metadata: { targetUserId: 'u2' } }), NOW), expected: { op: 'delete', driveId: 'drive', userId: 'u2' } });
  });
  it('re-adds a removed member with previous dates', () => {
    assert({
      given: 'a member_remove with recorded invite/accept dates',
      should: 'plan an insert using those dates',
      actual: planMemberRollback(act({ operation: 'member_remove', metadata: { targetUserId: 'u2' }, previousValues: { role: 'ADMIN', customRoleId: 'c', invitedBy: 'ib', invitedAt: '2024-01-01T00:00:00.000Z', acceptedAt: '2024-02-01T00:00:00.000Z' } }), NOW),
      expected: { op: 'insert', values: { driveId: 'drive', userId: 'u2', role: 'ADMIN', customRoleId: 'c', invitedBy: 'ib', invitedAt: new Date('2024-01-01T00:00:00.000Z'), acceptedAt: new Date('2024-02-01T00:00:00.000Z') } },
    });
  });
  it('re-adds a removed member defaulting dates to now and role to MEMBER', () => {
    assert({
      given: 'a member_remove with no recorded dates or role',
      should: 'default invitedAt/acceptedAt to now and role to MEMBER',
      actual: planMemberRollback(act({ operation: 'member_remove', metadata: { targetUserId: 'u2' }, previousValues: { userId: 'u2' } }), NOW),
      expected: { op: 'insert', values: { driveId: 'drive', userId: 'u2', role: 'MEMBER', customRoleId: null, invitedBy: null, invitedAt: NOW, acceptedAt: NOW } },
    });
  });
  it('restores a changed role and customRole', () => {
    assert({ given: 'a member_role_change with a prior role and customRoleId', should: 'plan an update with both', actual: planMemberRollback(act({ operation: 'member_role_change', metadata: { targetUserId: 'u2' }, previousValues: { role: 'MEMBER', customRoleId: 'c1', userId: 'u2' } }), NOW), expected: { op: 'update', driveId: 'drive', userId: 'u2', set: { role: 'MEMBER', customRoleId: 'c1' } } });
  });
});

describe('planRoleRollback', () => {
  it('throws without a driveId', () => {
    assert({ given: 'no driveId', should: 'throw', actual: thrown(() => planRoleRollback(act({ driveId: null }), NOW)), expected: 'Drive ID not found in activity' });
  });
  it('reorders roles to the previous order', () => {
    assert({ given: 'a role_reorder with a previous order', should: 'plan a reorder', actual: planRoleRollback(act({ operation: 'role_reorder', previousValues: { order: ['r1', 'r2'] } }), NOW), expected: { op: 'reorder', order: ['r1', 'r2'] } });
  });
  it('throws on role_reorder with no previous order', () => {
    assert({ given: 'a role_reorder with no order', should: 'throw', actual: thrown(() => planRoleRollback(act({ operation: 'role_reorder', previousValues: {} }), NOW)), expected: 'No previous role order found for rollback' });
  });
  it('throws when no role id is resolvable', () => {
    assert({ given: 'an update with no resourceId or roleId', should: 'throw', actual: thrown(() => planRoleRollback(act({ operation: 'update', resourceId: '', metadata: null }), NOW)), expected: 'Role ID not found in activity' });
  });
  it('deletes a role that was created', () => {
    assert({ given: 'a role create', should: 'plan delete-role', actual: planRoleRollback(act({ operation: 'create', resourceId: 'r9' }), NOW), expected: { op: 'delete-role', roleId: 'r9' } });
  });
  it('re-creates a deleted role with defaults', () => {
    assert({
      given: 'a role delete with partial previousValues',
      should: 'plan insert-role with defaults filled',
      actual: planRoleRollback(act({ operation: 'delete', resourceId: 'r9', previousValues: { name: 'Admins' } }), NOW),
      expected: { op: 'insert-role', values: { id: 'r9', driveId: 'drive', name: 'Admins', description: null, color: null, isDefault: false, permissions: {}, position: 0, updatedAt: NOW } },
    });
  });
  it('updates a changed role and stamps updatedAt', () => {
    assert({ given: 'a role update', should: 'plan update-role with updatedAt', actual: planRoleRollback(act({ operation: 'update', resourceId: 'r9', previousValues: { name: 'Old' } }), NOW), expected: { op: 'update-role', roleId: 'r9', set: { name: 'Old', updatedAt: NOW } } });
  });
  it('throws updating a role with no known fields', () => {
    assert({ given: 'a role update with no known fields', should: 'throw', actual: thrown(() => planRoleRollback(act({ operation: 'update', resourceId: 'r9', previousValues: { unrelated: 1 } }), NOW)), expected: 'No role values to restore' });
  });
});

describe('planMessageRollback', () => {
  it('deactivates a created message', () => {
    assert({ given: 'a message create', should: 'plan deactivation', actual: planMessageRollback(act({ operation: 'create' }), false), expected: { set: { isActive: false }, returnValue: { deactivated: true, isActive: false } } });
  });
  it('restores content and clears editedAt for a non-channel edit', () => {
    assert({ given: 'a non-channel message_update', should: 'restore content and null editedAt', actual: planMessageRollback(act({ operation: 'message_update', previousValues: { content: 'old' } }), false), expected: { set: { content: 'old', editedAt: null }, returnValue: { content: 'old', editedAt: null } } });
  });
  it('restores content only for a channel edit', () => {
    assert({ given: 'a channel message_update', should: 'restore content without editedAt in the set', actual: planMessageRollback(act({ operation: 'message_update', previousValues: { content: 'old' } }), true), expected: { set: { content: 'old' }, returnValue: { content: 'old', editedAt: null } } });
  });
  it('throws on an edit with no previous content', () => {
    assert({ given: 'a message_update with no previous content', should: 'throw', actual: thrown(() => planMessageRollback(act({ operation: 'message_update', previousValues: {} }), false)), expected: 'No previous content found for message rollback' });
  });
  it('restores a deleted message', () => {
    assert({ given: 'a message_delete', should: 'plan reactivation', actual: planMessageRollback(act({ operation: 'message_delete' }), false), expected: { set: { isActive: true }, returnValue: { restored: true, isActive: true } } });
  });
  it('throws on an unsupported operation', () => {
    assert({ given: 'an unsupported message operation', should: 'throw', actual: thrown(() => planMessageRollback(act({ operation: 'weird' }), false)), expected: 'Unsupported message operation: weird' });
  });
});
