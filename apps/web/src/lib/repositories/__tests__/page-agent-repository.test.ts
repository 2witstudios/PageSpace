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

import { calculateNextPosition, pageAgentRepository } from '../page-agent-repository';

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
    sandboxEnabled: true,
    isTrashed: false,
  };

  function mockSelectResult(row: Record<string, unknown> | undefined) {
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve(row ? [row] : []),
      }),
    }));
  }

  it('returns the agent row mapped to AgentDetails', async () => {
    mockSelectResult({ ...basePageRow });

    const agent = await pageAgentRepository.getAgentById('agent_1');

    expect(agent).toMatchObject({ id: 'agent_1', title: 'Test Agent', type: 'AI_CHAT' });
    // The sandbox switch travels with the rest of the agent's tool config: the
    // voice path reads it from here, and a shape that dropped it would offer a
    // switched-off agent the sandbox families (issue #2460).
    expect(agent?.sandboxEnabled).toBe(true);
  });

  it('returns null when the agent does not exist', async () => {
    mockSelectResult(undefined);

    const agent = await pageAgentRepository.getAgentById('missing');

    expect(agent).toBeNull();
  });
});
