import { describe, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert } from '@/lib/ai/core/__tests__/riteway';

vi.mock('@/lib/repositories/tool-approval-repository', () => ({ toolApprovalRepository: {} }));
vi.mock('@/lib/ai/approvals/run-approved-executions', () => ({ runApprovedToolExecutions: vi.fn() }));

import { approvalResumeRefusal, headlessApprovalResponseRefusal } from '../approval-turn-support';

describe('headlessApprovalResponseRefusal', () => {
  it('lets a browser session answer its approval cards', () => {
    assert({
      given: 'session auth',
      should: 'not refuse',
      actual: headlessApprovalResponseRefusal({ tokenType: 'session' }),
      expected: null,
    });
  });

  it.each(['mcp', 'oauth', 'service'] as const)(
    'refuses approval responses from %s auth: a headless client cannot approve a write or mint a grant',
    async (tokenType) => {
      const refusal = headlessApprovalResponseRefusal({ tokenType });
      assert({
        given: `${tokenType} auth carrying approval responses`,
        should: 'answer 403 with the approval_requires_session code',
        actual: { status: refusal?.status, body: await refusal?.json() },
        expected: {
          status: 403,
          body: {
            error: 'Tool approvals can only be answered from a signed-in browser session.',
            code: 'approval_requires_session',
          },
        },
      });
    },
  );
});

describe('approvalResumeRefusal', () => {
  it('maps a lock timeout to a retryable 503 — nothing was claimed', async () => {
    const refusal = approvalResumeRefusal({ kind: 'busy' });
    assert({
      given: 'a busy message',
      should: 'answer 503 approval_busy',
      actual: { status: refusal?.status, code: (await refusal?.json())?.code },
      expected: { status: 503, code: 'approval_busy' },
    });
  });
});

describe('page chat (which admits MCP tokens) refuses headless approval responses before applying them', () => {
  const source = readFileSync(resolve(__dirname, '../page-chat-turn.ts'), 'utf8');
  it('checks the principal before applyToolApprovalResponsesToPageMessage', () => {
    const guard = source.indexOf('headlessApprovalResponseRefusal(authResult)');
    const apply = source.indexOf('await applyToolApprovalResponsesToPageMessage(');
    assert({
      given: 'page-chat-turn.ts',
      should: 'refuse a headless principal before any approval is claimed',
      actual: guard > -1 && apply > -1 && guard < apply,
      expected: true,
    });
  });
});
