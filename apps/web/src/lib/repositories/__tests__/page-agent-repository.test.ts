/**
 * Unit tests for page-agent-repository
 *
 * Tests for pure functions that contain business logic.
 * Database operations are tested via integration tests, except for
 * getAgentById's jsonb-coercion contract, which is cheap to verify here
 * with a mocked db select chain.
 */

import { describe, it, expect, vi } from 'vitest';

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id' },
  drives: { id: 'id' },
}));

import { calculateNextPosition, isMachineRef, isMachineRefArray, pageAgentRepository } from '../page-agent-repository';

describe('calculateNextPosition', () => {
  it('should return 1 when there are no siblings', () => {
    const result = calculateNextPosition([]);

    expect(result).toBe(1);
  });

  it('should return next position after highest sibling', () => {
    const siblings = [
      { position: 5 },  // Highest (ordered desc by DB)
      { position: 3 },
      { position: 1 },
    ];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(6);
  });

  it('should handle single sibling', () => {
    const siblings = [{ position: 10 }];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(11);
  });

  it('should handle siblings with position 0', () => {
    const siblings = [{ position: 0 }];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(1);
  });

  it('should handle negative positions (edge case)', () => {
    // While negative positions shouldn't happen, the function should handle it
    const siblings = [{ position: -1 }];

    const result = calculateNextPosition(siblings);

    expect(result).toBe(0);
  });
});

describe('isMachineRef', () => {
  it('accepts { kind: "own" }', () => {
    expect(isMachineRef({ kind: 'own' })).toBe(true);
  });

  it('accepts { kind: "existing", machineId }', () => {
    expect(isMachineRef({ kind: 'existing', machineId: 'term_1' })).toBe(true);
  });

  it('rejects "existing" without a machineId', () => {
    expect(isMachineRef({ kind: 'existing' })).toBe(false);
  });

  it('rejects "existing" with an empty machineId', () => {
    expect(isMachineRef({ kind: 'existing', machineId: '' })).toBe(false);
  });

  it('rejects "existing" with a non-string machineId', () => {
    expect(isMachineRef({ kind: 'existing', machineId: 123 })).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isMachineRef({ kind: 'other' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isMachineRef('own')).toBe(false);
    expect(isMachineRef(null)).toBe(false);
    expect(isMachineRef(undefined)).toBe(false);
  });
});

describe('isMachineRefArray', () => {
  it('accepts an empty array', () => {
    expect(isMachineRefArray([])).toBe(true);
  });

  it('accepts an array of valid MachineRefs', () => {
    expect(
      isMachineRefArray([{ kind: 'own' }, { kind: 'existing', machineId: 'term_1' }])
    ).toBe(true);
  });

  it('rejects an array containing an invalid entry', () => {
    expect(isMachineRefArray([{ kind: 'own' }, { kind: 'existing' }])).toBe(false);
  });

  it('rejects non-array values', () => {
    expect(isMachineRefArray({ kind: 'own' })).toBe(false);
    expect(isMachineRefArray(null)).toBe(false);
    expect(isMachineRefArray(undefined)).toBe(false);
  });
});

describe('getAgentById', () => {
  const basePageRow = {
    id: 'agent_1',
    title: 'Test Agent',
    type: 'AI_CHAT',
    driveId: 'drive_1',
    parentId: null,
    systemPrompt: null,
    enabledTools: null,
    aiProvider: null,
    aiModel: null,
    toolExposureMode: 'upfront' as const,
    isTrashed: false,
  };

  function mockSelectResult(row: Record<string, unknown> | undefined) {
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve(row ? [row] : []),
      }),
    }));
  }

  it('coerces a NULL machines column to an empty array and machineAccess to false', async () => {
    mockSelectResult({ ...basePageRow, machineAccess: null, machines: null });

    const agent = await pageAgentRepository.getAgentById('agent_1');

    expect(agent?.machineAccess).toBe(false);
    expect(agent?.machines).toEqual([]);
  });

  it('coerces missing machineAccess/machines fields (pre-existing row) to defaults', async () => {
    mockSelectResult({ ...basePageRow });

    const agent = await pageAgentRepository.getAgentById('agent_1');

    expect(agent?.machineAccess).toBe(false);
    expect(agent?.machines).toEqual([]);
  });

  it('passes through a populated machines column and machineAccess: true', async () => {
    const machines = [{ kind: 'own' }, { kind: 'existing', machineId: 'term_1' }];
    mockSelectResult({ ...basePageRow, machineAccess: true, machines });

    const agent = await pageAgentRepository.getAgentById('agent_1');

    expect(agent?.machineAccess).toBe(true);
    expect(agent?.machines).toEqual(machines);
  });

  it('discards a malformed machines column rather than surfacing bad data', async () => {
    mockSelectResult({ ...basePageRow, machineAccess: false, machines: [{ kind: 'bogus' }] });

    const agent = await pageAgentRepository.getAgentById('agent_1');

    expect(agent?.machines).toEqual([]);
  });

  it('returns null when the agent does not exist', async () => {
    mockSelectResult(undefined);

    const agent = await pageAgentRepository.getAgentById('missing');

    expect(agent).toBeNull();
  });
});
