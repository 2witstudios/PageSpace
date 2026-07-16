import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import type { ActivityLogForRollback } from '../../rollback-service';
import {
  planPageRedo,
  planDriveRedo,
  planPermissionRedo,
  planAgentRedo,
  planMemberRedo,
  planRoleRedo,
  planMessageRedo,
} from '../redo-plans';

const NOW = new Date('2024-05-05T05:05:05.000Z');
const AGENT_FIELDS = ['systemPrompt', 'enabledTools'] as const;

function act(overrides: Partial<ActivityLogForRollback> = {}): ActivityLogForRollback {
  return {
    id: 'a', timestamp: NOW, userId: 'u', actorEmail: 'e', actorDisplayName: null,
    operation: 'rollback', resourceType: 'page', resourceId: 'res', resourceTitle: null,
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

describe('planPageRedo / planDriveRedo', () => {
  it('uses target values when present', () => {
    assert({ given: 'target values', should: 'apply them', actual: planPageRedo({ title: 't' }, 'update'), expected: { title: 't' } });
  });
  it('trashes when the source op was a delete', () => {
    assert({ given: 'no target values and a delete source op', should: 'set isTrashed true', actual: planPageRedo(null, 'delete'), expected: { isTrashed: true } });
  });
  it('trashes when the source op was a trash', () => {
    assert({ given: 'no target values and a trash source op', should: 'set isTrashed true', actual: planPageRedo({}, 'trash'), expected: { isTrashed: true } });
  });
  it('un-trashes when the source op was a create', () => {
    assert({ given: 'no target values and a create source op', should: 'set isTrashed false', actual: planPageRedo(null, 'create'), expected: { isTrashed: false } });
  });
  it('throws when nothing can be resolved', () => {
    assert({ given: 'no target values and an unhandled source op', should: 'throw', actual: thrown(() => planPageRedo(null, 'update')), expected: 'No values to restore' });
  });
  it('drive redo shares the same resolution', () => {
    assert({ given: 'a drive delete source op', should: 'set isTrashed true', actual: planDriveRedo(null, 'delete'), expected: { isTrashed: true } });
  });
});

describe('planPermissionRedo', () => {
  it('throws without a pageId', () => {
    assert({ given: 'no pageId', should: 'throw', actual: thrown(() => planPermissionRedo(act({ pageId: null }), { userId: 'u2' }, 'permission_grant')), expected: 'Page ID not found in activity' });
  });
  it('throws without a target user', () => {
    assert({ given: 'no resolvable target user', should: 'throw', actual: thrown(() => planPermissionRedo(act({ metadata: null, newValues: null }), null, 'permission_grant')), expected: 'Target user ID not found in activity' });
  });
  it('resolves the target user from newValues when needed', () => {
    assert({ given: 'target user only in newValues', should: 'plan a delete for that user', actual: planPermissionRedo(act({ metadata: null, newValues: { userId: 'uN' } }), null, 'permission_revoke'), expected: { op: 'delete', pageId: 'page', userId: 'uN' } });
  });
  it('upserts on a grant redo with defaults', () => {
    assert({
      given: 'a permission_grant redo with partial target values',
      should: 'plan an upsert defaulting the rest',
      actual: planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), { canEdit: true }, 'permission_grant'),
      expected: { op: 'upsert', pageId: 'page', userId: 'u2', values: { pageId: 'page', userId: 'u2', canView: false, canEdit: true, canShare: false, canDelete: false, note: null, expiresAt: null, grantedBy: null } },
    });
  });
  it('throws on a grant redo with no target values', () => {
    assert({ given: 'a permission_grant redo with null target values', should: 'throw', actual: thrown(() => planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), null, 'permission_grant')), expected: 'No permission values to apply' });
  });
  it('updates on a permission_update redo', () => {
    assert({ given: 'a permission_update redo', should: 'plan an update', actual: planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), { canView: true }, 'permission_update'), expected: { op: 'update', pageId: 'page', userId: 'u2', set: { canView: true } } });
  });
  it('throws on a permission_update redo with no target values', () => {
    assert({ given: 'a permission_update redo with null target values', should: 'throw', actual: thrown(() => planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), null, 'permission_update')), expected: 'No permission values to apply' });
  });
  it('throws on a permission_update redo with empty applicable values', () => {
    assert({ given: 'a permission_update redo with no known fields', should: 'throw', actual: thrown(() => planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), { unrelated: 1 }, 'permission_update')), expected: 'No permission values to apply' });
  });
  it('deletes on a permission_revoke redo', () => {
    assert({ given: 'a permission_revoke redo', should: 'plan a delete', actual: planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), null, 'permission_revoke'), expected: { op: 'delete', pageId: 'page', userId: 'u2' } });
  });
  it('throws on an unsupported source operation', () => {
    assert({ given: 'an unsupported source op', should: 'throw', actual: thrown(() => planPermissionRedo(act({ metadata: { targetUserId: 'u2' } }), {}, 'weird' as never)), expected: 'Unsupported permission operation: weird' });
  });
});

describe('planAgentRedo', () => {
  it('throws without a pageId', () => {
    assert({ given: 'no pageId', should: 'throw', actual: thrown(() => planAgentRedo(act({ pageId: null }), { systemPrompt: 'x' }, AGENT_FIELDS)), expected: 'Page ID not found in activity' });
  });
  it('throws without target values', () => {
    assert({ given: 'null target values', should: 'throw', actual: thrown(() => planAgentRedo(act(), null, AGENT_FIELDS)), expected: 'No agent values to apply' });
  });
  it('applies whitelisted fields', () => {
    assert({ given: 'target values with a whitelisted field', should: 'apply it', actual: planAgentRedo(act(), { systemPrompt: 'new', other: 1 }, AGENT_FIELDS), expected: { updateData: { systemPrompt: 'new' } } });
  });
  it('throws with no whitelisted values', () => {
    assert({ given: 'target values with nothing whitelisted', should: 'throw', actual: thrown(() => planAgentRedo(act(), { other: 1 }, AGENT_FIELDS)), expected: 'No agent values to apply' });
  });
});

describe('planMemberRedo', () => {
  it('throws without a driveId', () => {
    assert({ given: 'no driveId', should: 'throw', actual: thrown(() => planMemberRedo(act({ driveId: null }), { userId: 'u2' }, 'member_add', NOW)), expected: 'Drive ID not found in activity' });
  });
  it('throws without a target user', () => {
    assert({ given: 'no resolvable target user', should: 'throw', actual: thrown(() => planMemberRedo(act({ metadata: null, newValues: null }), null, 'member_add', NOW)), expected: 'Target user ID not found in activity' });
  });
  it('upserts a member add with recorded dates', () => {
    assert({
      given: 'a member_add redo with recorded dates',
      should: 'upsert using those dates',
      actual: planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), { role: 'ADMIN', customRoleId: 'c', invitedBy: 'ib', invitedAt: '2024-01-01T00:00:00.000Z', acceptedAt: '2024-02-01T00:00:00.000Z' }, 'member_add', NOW),
      expected: { op: 'upsert', values: { driveId: 'drive', userId: 'u2', role: 'ADMIN', customRoleId: 'c', invitedBy: 'ib', invitedAt: new Date('2024-01-01T00:00:00.000Z'), acceptedAt: new Date('2024-02-01T00:00:00.000Z') } },
    });
  });
  it('upserts a member add defaulting dates and role', () => {
    assert({
      given: 'a member_add redo with no dates or role',
      should: 'default invitedAt to now, acceptedAt to null, role to MEMBER',
      actual: planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), {}, 'member_add', NOW),
      expected: { op: 'upsert', values: { driveId: 'drive', userId: 'u2', role: 'MEMBER', customRoleId: null, invitedBy: null, invitedAt: NOW, acceptedAt: null } },
    });
  });
  it('deletes on a member remove redo', () => {
    assert({ given: 'a member_remove redo', should: 'plan a delete', actual: planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), null, 'member_remove', NOW), expected: { op: 'delete', driveId: 'drive', userId: 'u2' } });
  });
  it('updates on a member role change redo', () => {
    assert({ given: 'a member_role_change redo', should: 'plan an update', actual: planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), { role: 'ADMIN' }, 'member_role_change', NOW), expected: { op: 'update', driveId: 'drive', userId: 'u2', set: { role: 'ADMIN' } } });
  });
  it('throws on a member role change redo with no target values', () => {
    assert({ given: 'a member_role_change redo with null target values', should: 'throw', actual: thrown(() => planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), null, 'member_role_change', NOW)), expected: 'No member values to apply' });
  });
  it('throws on a member role change redo with empty applicable values', () => {
    assert({ given: 'a member_role_change redo with no known fields', should: 'throw', actual: thrown(() => planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), { unrelated: 1 }, 'member_role_change', NOW)), expected: 'No member values to apply' });
  });
  it('throws on an unsupported source op', () => {
    assert({ given: 'an unsupported source op', should: 'throw', actual: thrown(() => planMemberRedo(act({ metadata: { targetUserId: 'u2' } }), {}, 'weird' as never, NOW)), expected: 'Unsupported member operation: weird' });
  });
});

describe('planRoleRedo', () => {
  it('throws without a driveId', () => {
    assert({ given: 'no driveId', should: 'throw', actual: thrown(() => planRoleRedo(act({ driveId: null }), {}, 'create', NOW)), expected: 'Drive ID not found in activity' });
  });
  it('throws without a role id', () => {
    assert({ given: 'no roleId or resourceId', should: 'throw', actual: thrown(() => planRoleRedo(act({ resourceId: '', metadata: null }), {}, 'create', NOW)), expected: 'Role ID not found in activity' });
  });
  it('reorders roles', () => {
    assert({ given: 'a role_reorder redo', should: 'plan a reorder', actual: planRoleRedo(act({ resourceId: 'r1' }), { order: ['a', 'b'] }, 'role_reorder', NOW), expected: { op: 'reorder', order: ['a', 'b'] } });
  });
  it('throws on a role_reorder redo with no order', () => {
    assert({ given: 'a role_reorder redo with empty order', should: 'throw', actual: thrown(() => planRoleRedo(act({ resourceId: 'r1' }), {}, 'role_reorder', NOW)), expected: 'No role order found to apply' });
  });
  it('inserts a role on a create redo', () => {
    assert({
      given: 'a role create redo with a name',
      should: 'plan insert-role with defaults',
      actual: planRoleRedo(act({ resourceId: 'r1' }), { name: 'Ops' }, 'create', NOW),
      expected: { op: 'insert-role', values: { id: 'r1', driveId: 'drive', name: 'Ops', description: null, color: null, isDefault: false, permissions: {}, position: 0, updatedAt: NOW } },
    });
  });
  it('throws on a create redo with no target values', () => {
    assert({ given: 'a create redo with null target values', should: 'throw', actual: thrown(() => planRoleRedo(act({ resourceId: 'r1' }), null, 'create', NOW)), expected: 'No role values to apply' });
  });
  it('deletes a role on a delete redo', () => {
    assert({ given: 'a role delete redo', should: 'plan delete-role', actual: planRoleRedo(act({ resourceId: 'r1' }), {}, 'delete', NOW), expected: { op: 'delete-role', roleId: 'r1' } });
  });
  it('updates a role on an update redo', () => {
    assert({ given: 'a role update redo', should: 'plan update-role with updatedAt', actual: planRoleRedo(act({ resourceId: 'r1' }), { name: 'New' }, 'update', NOW), expected: { op: 'update-role', roleId: 'r1', set: { name: 'New', updatedAt: NOW } } });
  });
  it('throws on an update redo with no target values', () => {
    assert({ given: 'an update redo with null target values', should: 'throw', actual: thrown(() => planRoleRedo(act({ resourceId: 'r1' }), null, 'update', NOW)), expected: 'No role values to apply' });
  });
  it('throws on an update redo with no known fields', () => {
    assert({ given: 'an update redo with no known fields', should: 'throw', actual: thrown(() => planRoleRedo(act({ resourceId: 'r1' }), { unrelated: 1 }, 'update', NOW)), expected: 'No role values to apply' });
  });
  it('throws on an unsupported source op', () => {
    assert({ given: 'an unsupported source op', should: 'throw', actual: thrown(() => planRoleRedo(act({ resourceId: 'r1' }), {}, 'weird' as never, NOW)), expected: 'Unsupported role operation: weird' });
  });
});

describe('planMessageRedo', () => {
  it('applies content with an edit timestamp for a non-channel edit', () => {
    assert({ given: 'a non-channel message_update redo', should: 'set content and editedAt', actual: planMessageRedo({ content: 'new' }, 'message_update', false, NOW), expected: { content: 'new', editedAt: NOW } });
  });
  it('applies content without an edit timestamp for a channel edit', () => {
    assert({ given: 'a channel message_update redo', should: 'set content only', actual: planMessageRedo({ content: 'new' }, 'message_update', true, NOW), expected: { content: 'new' } });
  });
  it('throws on an edit redo with no content', () => {
    assert({ given: 'a message_update redo with no content', should: 'throw', actual: thrown(() => planMessageRedo({}, 'message_update', false, NOW)), expected: 'No message content to apply' });
  });
  it('deactivates on a delete redo', () => {
    assert({ given: 'a message_delete redo', should: 'set isActive false', actual: planMessageRedo(null, 'message_delete', false, NOW), expected: { isActive: false } });
  });
  it('reactivates on a create redo', () => {
    assert({ given: 'a create redo', should: 'set isActive true', actual: planMessageRedo(null, 'create', false, NOW), expected: { isActive: true } });
  });
  it('throws on an unsupported source op', () => {
    assert({ given: 'an unsupported source op', should: 'throw', actual: thrown(() => planMessageRedo(null, 'weird' as never, false, NOW)), expected: 'Unsupported message operation: weird' });
  });
});
