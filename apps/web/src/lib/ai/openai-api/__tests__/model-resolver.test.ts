import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';

const where = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));

import { resolveAgentModel } from '../model-resolver';

const agentPage = {
  id: 'page-1',
  title: 'Support Agent',
  type: 'AI_CHAT',
  driveId: 'drive-1',
};

describe('resolveAgentModel', () => {
  beforeEach(() => {
    where.mockReset();
  });

  test('ps-agent:// scheme resolving to an AI_CHAT page', async () => {
    where.mockResolvedValue([agentPage]);

    const result = await resolveAgentModel('ps-agent://page-1');

    assert({
      given: 'a ps-agent:// model pointing at an existing agent page',
      should: 'resolve to that agent page',
      actual: result,
      expected: { ok: true, pageId: 'page-1', page: agentPage },
    });
  });

  test('model string not using the ps-agent:// scheme', async () => {
    const result = await resolveAgentModel('gpt-4o');

    assert({
      given: 'a model string that is not a ps-agent:// reference',
      should: 'reject it as an invalid model without a database lookup',
      actual: { ok: result.ok, status: result.ok ? null : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('ps-agent:// scheme pointing at a missing page', async () => {
    where.mockResolvedValue([]);

    const result = await resolveAgentModel('ps-agent://ghost');

    assert({
      given: 'a ps-agent:// model whose page does not exist',
      should: 'reject it as a model that does not exist',
      actual: { ok: result.ok, status: result.ok ? null : result.status },
      expected: { ok: false, status: 404 },
    });
  });

  test('ps-agent:// scheme pointing at a non-agent page', async () => {
    where.mockResolvedValue([{ ...agentPage, type: 'DOCUMENT' }]);

    const result = await resolveAgentModel('ps-agent://page-1');

    assert({
      given: 'a ps-agent:// model whose page is not an AI_CHAT agent',
      should: 'reject it as a model that does not exist',
      actual: { ok: result.ok, status: result.ok ? null : result.status },
      expected: { ok: false, status: 404 },
    });
  });
});
