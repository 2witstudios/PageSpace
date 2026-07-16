import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import {
  VALID_OPERATIONS,
  isValidOperation,
  OPERATION_SUMMARY_LABELS,
  getOperationSummaryLabel,
  REDO_ALLOW_MISSING_TARGET,
  ROLLBACK_ALLOW_MISSING_TARGET,
  AGENT_CONFIG_ROLLBACK_FIELDS,
} from '../operations';

describe('operations — isValidOperation', () => {
  it('accepts a known operation', () => {
    assert({
      given: 'an operation that is in VALID_OPERATIONS',
      should: 'return true',
      actual: isValidOperation('create'),
      expected: true,
    });
  });

  it('accepts every listed operation', () => {
    assert({
      given: 'each operation in VALID_OPERATIONS',
      should: 'be recognized as valid',
      actual: VALID_OPERATIONS.every((op) => isValidOperation(op)),
      expected: true,
    });
  });

  it('rejects an unknown operation', () => {
    assert({
      given: 'a string not in VALID_OPERATIONS',
      should: 'return false',
      actual: isValidOperation('not_a_real_operation'),
      expected: false,
    });
  });
});

describe('operations — getOperationSummaryLabel', () => {
  it('maps a known operation to its label', () => {
    assert({
      given: 'an operation present in OPERATION_SUMMARY_LABELS',
      should: 'return the mapped label',
      actual: getOperationSummaryLabel('permission_grant'),
      expected: 'Grant permission',
    });
  });

  it('falls back to the raw operation for an unmapped key', () => {
    assert({
      given: 'an operation absent from OPERATION_SUMMARY_LABELS',
      should: 'return the operation string unchanged',
      actual: getOperationSummaryLabel('login'),
      expected: 'login',
    });
  });

  it('exposes a Create label for create', () => {
    assert({
      given: 'the create operation',
      should: 'be labeled Create',
      actual: OPERATION_SUMMARY_LABELS.create,
      expected: 'Create',
    });
  });
});

describe('operations — allow-missing-target sets', () => {
  it('redo set contains member_remove', () => {
    assert({
      given: 'the redo allow-missing-target set',
      should: 'include member_remove',
      actual: REDO_ALLOW_MISSING_TARGET.has('member_remove'),
      expected: true,
    });
  });

  it('redo set excludes permission_grant', () => {
    assert({
      given: 'the redo allow-missing-target set',
      should: 'not include permission_grant',
      actual: REDO_ALLOW_MISSING_TARGET.has('permission_grant'),
      expected: false,
    });
  });

  it('rollback set contains permission_grant', () => {
    assert({
      given: 'the rollback allow-missing-target set',
      should: 'include permission_grant',
      actual: ROLLBACK_ALLOW_MISSING_TARGET.has('permission_grant'),
      expected: true,
    });
  });

  it('rollback set excludes delete', () => {
    assert({
      given: 'the rollback allow-missing-target set',
      should: 'not include delete',
      actual: ROLLBACK_ALLOW_MISSING_TARGET.has('delete'),
      expected: false,
    });
  });

  it('redo set membership matches its documented contents', () => {
    assert({
      given: 'the redo allow-missing-target set',
      should: 'contain exactly member_remove, permission_revoke, delete, trash',
      actual: [...REDO_ALLOW_MISSING_TARGET].sort(),
      expected: ['delete', 'member_remove', 'permission_revoke', 'trash'],
    });
  });

  it('rollback set membership matches its documented contents', () => {
    assert({
      given: 'the rollback allow-missing-target set',
      should: 'contain exactly permission_grant, member_add, message_delete',
      actual: [...ROLLBACK_ALLOW_MISSING_TARGET].sort(),
      expected: ['member_add', 'message_delete', 'permission_grant'],
    });
  });
});

describe('operations — AGENT_CONFIG_ROLLBACK_FIELDS', () => {
  it('is the single source of truth for agent-config undo fields', () => {
    assert({
      given: 'the agent-config rollback field whitelist',
      should: 'match the fields writable by update_agent_config',
      actual: [...AGENT_CONFIG_ROLLBACK_FIELDS],
      expected: [
        'systemPrompt',
        'enabledTools',
        'aiProvider',
        'aiModel',
        'includeDrivePrompt',
        'agentDefinition',
        'visibleToGlobalAssistant',
        'includePageTree',
        'pageTreeScope',
        'toolExposureMode',
        'userScopedAccess',
      ],
    });
  });
});
