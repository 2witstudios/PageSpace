import { describe, test, vi } from 'vitest';
import { assert } from './riteway';
import { makeAgentResolver, parseAgentModelUri } from '../resolve-agent';
import { PageType } from '@pagespace/lib/utils/enums';

const aiChatPage = {
  id: 'page-123',
  type: PageType.AI_CHAT,
  title: 'My Agent',
  driveId: 'drive-abc',
  systemPrompt: null,
  aiProvider: 'pagespace',
  aiModel: 'glm-4.5-air',
};

describe('parseAgentModelUri', () => {
  test('valid ps-agent URI', () => {
    assert({
      given: 'a model string of ps-agent://<pageId>',
      should: 'return the pageId',
      actual: parseAgentModelUri('ps-agent://page-123'),
      expected: 'page-123',
    });
  });

  test('non-ps-agent URI', () => {
    assert({
      given: 'a model string not starting with ps-agent://',
      should: 'return null',
      actual: parseAgentModelUri('gpt-4o'),
      expected: null,
    });
  });

  test('ps-agent URI with no pageId', () => {
    assert({
      given: 'a model string of ps-agent:// with no trailing pageId',
      should: 'return null',
      actual: parseAgentModelUri('ps-agent://'),
      expected: null,
    });
  });
});

describe('makeAgentResolver', () => {
  test('resolves a valid AI_CHAT page the user can view', async () => {
    const queryPage = vi.fn().mockResolvedValue(aiChatPage);
    const canView = vi.fn().mockResolvedValue(true);
    const resolve = makeAgentResolver({ queryPage, canView });

    const result = await resolve('page-123', 'user-1');
    assert({
      given: 'a valid pageId for an AI_CHAT page the user can view',
      should: 'return ok:true with the page',
      actual: result,
      expected: { ok: true, page: aiChatPage },
    });
  });

  test('returns 404 when page does not exist', async () => {
    const queryPage = vi.fn().mockResolvedValue(null);
    const canView = vi.fn().mockResolvedValue(true);
    const resolve = makeAgentResolver({ queryPage, canView });

    const result = await resolve('nonexistent', 'user-1');
    assert({
      given: 'a pageId that does not exist in the pages table',
      should: 'return ok:false with status 404',
      actual: result,
      expected: { ok: false, status: 404, error: 'Agent not found' },
    });
  });

  test('returns 404 when page exists but is not AI_CHAT type', async () => {
    const nonAgentPage = { ...aiChatPage, type: PageType.DOCUMENT };
    const queryPage = vi.fn().mockResolvedValue(nonAgentPage);
    const canView = vi.fn().mockResolvedValue(true);
    const resolve = makeAgentResolver({ queryPage, canView });

    const result = await resolve('page-123', 'user-1');
    assert({
      given: 'a pageId for a non-AI_CHAT page',
      should: 'return ok:false with status 404',
      actual: result,
      expected: { ok: false, status: 404, error: 'Agent not found' },
    });
  });

  test('returns 403 when user cannot view the page', async () => {
    const queryPage = vi.fn().mockResolvedValue(aiChatPage);
    const canView = vi.fn().mockResolvedValue(false);
    const resolve = makeAgentResolver({ queryPage, canView });

    const result = await resolve('page-123', 'user-1');
    assert({
      given: 'a valid AI_CHAT page the user does not have view permission for',
      should: 'return ok:false with status 403',
      actual: result,
      expected: { ok: false, status: 403, error: 'Access denied' },
    });
  });
});
