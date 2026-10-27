/**
 * GA wave 2 — is the conversation's bound session on a LOCAL environment?
 * Only then is `request_env_approval` offered. Every failure is "not local".
 */
import { describe, it, expect } from 'vitest';
import { resolveLocalEnvBinding, withEnvApprovalTool, type LocalEnvBindingDeps } from '../local-env-binding';

function deps(over: Partial<LocalEnvBindingDeps> = {}): LocalEnvBindingDeps {
  return {
    findSessionForConversation: async () => ({ envId: 'env_1' }),
    findEnv: async () => ({ substrate: 'local' }),
    ...over,
  };
}

describe('resolveLocalEnvBinding', () => {
  it('given a bound session on a local env, should answer the envId', async () => {
    expect(await resolveLocalEnvBinding('conv_1', deps())).toEqual({ envId: 'env_1' });
  });

  it.each([
    ['no conversation id', undefined, deps()],
    ['no session', 'conv_1', deps({ findSessionForConversation: async () => null })],
    ['a session with no env (ephemeral)', 'conv_1', deps({ findSessionForConversation: async () => ({ envId: null }) })],
    ['a Sprite env', 'conv_1', deps({ findEnv: async () => ({ substrate: 'sprite' }) })],
    ['a missing env row', 'conv_1', deps({ findEnv: async () => null })],
    ['a lookup that throws', 'conv_1', deps({ findSessionForConversation: async () => { throw new Error('db down'); } })],
  ])('given %s, should answer null (the tool is not offered)', async (_label, conversationId, d) => {
    expect(await resolveLocalEnvBinding(conversationId, d)).toBeNull();
  });
});

describe('withEnvApprovalTool', () => {
  it('given no conversation id (the production lookup answers null), should return the tools untouched and pause only on ask_user', async () => {
    const tools = { finish: {} };
    expect(await withEnvApprovalTool(tools, undefined)).toEqual({ tools, pauseToolNames: ['ask_user'], injected: false });
  });
});
