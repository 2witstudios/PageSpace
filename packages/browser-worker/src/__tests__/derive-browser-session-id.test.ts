import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { deriveBrowserSessionId } from '../derive-browser-session-id.js';

const base = { tenantId: 'tenant-1', ownerId: 'user-1', agentId: 'agent-page-1', conversationId: 'conv-1' };

describe('deriveBrowserSessionId', () => {
  it('names one session per tenant, owner, agent and conversation, the same way every time', () => {
    const id = deriveBrowserSessionId(base);
    assert({
      given: 'the same coordinates twice',
      should: 'give the same bws_ id of 40 hex characters',
      actual: [id === deriveBrowserSessionId({ ...base }), /^bws_[0-9a-f]{40}$/.test(id)],
      expected: [true, true],
    });
  });

  it('never lets two principals share a browser', () => {
    const variants = [
      { ...base, tenantId: 'tenant-2' },
      { ...base, ownerId: 'user-2' },
      { ...base, agentId: 'agent-page-2' },
      { ...base, conversationId: 'conv-2' },
      { ...base, tenantId: 'tenant-1user-1', ownerId: '' },
    ];
    const ids = new Set([deriveBrowserSessionId(base), ...variants.map((v) => deriveBrowserSessionId(v))]);
    assert({
      given: 'coordinates differing in any one field, including a concatenation collision attempt',
      should: 'give a different id for each',
      actual: ids.size,
      expected: variants.length + 1,
    });
  });
});
