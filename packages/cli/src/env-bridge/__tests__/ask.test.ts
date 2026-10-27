import { describe, expect, it, vi } from 'vitest';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { approvalKey, createAskPrompter, renderAskPrompt, type AskInput } from '../ask.js';

const request: NormalizedRequest = { op: 'exec', cmd: 'npm', args: ['test'], cwd: '/real/proj', paths: [], env: { CI: '1' }, timeoutMs: 5_000, maxBytes: 4096, clamped: true };
const input: AskInput = { grantId: 'g1', principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' }, op: 'exec', request };

describe('ask prompter (invariant 5: `ask` mode prompts once per new (principal, session) and per non-allowlisted op)', () => {
  it('renderAskPrompt should show EXACTLY the normalized request: principal, op, cmd/args, cwd, paths, env, caps, clamped', () => {
    const text = renderAskPrompt(input);
    for (const needle of ['u1', 's1', 'exec', 'npm', 'test', '/real/proj', 'CI=1', '5000', '4096', 'clamped']) expect(text).toContain(needle);
  });

  it('approvalKey should distinguish user, session and op', () => {
    expect(approvalKey(input.principal, 'exec')).not.toBe(approvalKey(input.principal, 'fs_read'));
    expect(approvalKey(input.principal, 'exec')).not.toBe(approvalKey({ ...input.principal, sessionId: 's2' }, 'exec'));
    expect(approvalKey(input.principal, 'exec')).toBe(approvalKey({ ...input.principal, conversationId: 'other' }, 'exec'));
  });

  it('given a first request for a (principal, session, op), should prompt; given an approved repeat, should NOT prompt again', async () => {
    const confirm = vi.fn(async () => true);
    const prompter = createAskPrompter({ confirm, write: () => undefined });
    expect(await prompter.ask(input)).toBe(true);
    expect(await prompter.ask({ ...input, grantId: 'g2' })).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('given a new op for the same session, or a new session, should prompt again', async () => {
    const confirm = vi.fn(async () => true);
    const prompter = createAskPrompter({ confirm, write: () => undefined });
    await prompter.ask(input);
    await prompter.ask({ ...input, op: 'fs_read', request: { ...request, op: 'fs_read', paths: ['/real/proj/a'] } });
    await prompter.ask({ ...input, principal: { ...input.principal, sessionId: 's2' } });
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('given a declined prompt, should return false and NOT remember it — the next request asks again', async () => {
    const confirm = vi.fn(async () => false);
    const prompter = createAskPrompter({ confirm, write: () => undefined });
    expect(await prompter.ask(input)).toBe(false);
    expect(await prompter.ask(input)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('given a confirm that throws (terminal closed), should treat it as declined', async () => {
    const prompter = createAskPrompter({ confirm: async () => { throw new Error('closed'); }, write: () => undefined });
    expect(await prompter.ask(input)).toBe(false);
  });
});
