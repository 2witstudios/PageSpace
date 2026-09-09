import { describe, expect, it, vi } from 'vitest';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { createAskPrompter, describeScope, describeSubject, renderAskPrompt, type AskInput } from '../ask.js';

const request: NormalizedRequest = { op: 'exec', cmd: 'npm', args: ['test'], cwd: '/real/proj', paths: [], env: { CI: '1' }, timeoutMs: 5_000, maxBytes: 4096, clamped: true };
const input: AskInput = { grantId: 'g1', principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' }, op: 'exec', request, subjects: ['exec:/usr/local/bin/npm'] };

describe('ask prompter (invariant 5) — shows the exact normalized request, remembers NOTHING itself (GA wave 2: approvals live in the store, keyed by subject)', () => {
  it('renderAskPrompt should show EXACTLY the normalized request: principal, op, cmd/args, cwd, paths, env, caps, clamped — and what an approval would cover', () => {
    const text = renderAskPrompt(input);
    for (const needle of ['u1', 's1', 'exec', 'npm', 'test', '/real/proj', 'CI=1', '5000', '4096', 'clamped', '/usr/local/bin/npm', 'any chat', 'never covers other programs']) expect(text).toContain(needle);
    expect(text).not.toMatch(/same user and session/);
  });

  it('renderAskPrompt for a request with no subjects should say it cannot be remembered', () => {
    expect(renderAskPrompt({ ...input, subjects: null })).toMatch(/cannot be remembered/);
  });

  it('given an approved prompt, should answer approved with the DEFAULT scope (30d) when no scope chooser is supplied', async () => {
    const confirm = vi.fn(async () => true);
    const prompter = createAskPrompter({ confirm, write: () => undefined });
    expect(await prompter.ask(input)).toEqual({ approved: true, scope: '30d' });
  });

  it('given a scope chooser, should ask it with the subjects and answer with the chosen scope', async () => {
    const chooseScope = vi.fn(async () => 'until_revoked' as const);
    const prompter = createAskPrompter({ confirm: async () => true, chooseScope, write: () => undefined });
    expect(await prompter.ask(input)).toEqual({ approved: true, scope: 'until_revoked' });
    expect(chooseScope).toHaveBeenCalledWith(['exec:/usr/local/bin/npm']);
  });

  it('given a request with no subjects, should NOT ask for a scope and answer once', async () => {
    const chooseScope = vi.fn(async () => '30d' as const);
    const prompter = createAskPrompter({ confirm: async () => true, chooseScope, write: () => undefined });
    expect(await prompter.ask({ ...input, subjects: null })).toEqual({ approved: true, scope: 'once' });
    expect(chooseScope).not.toHaveBeenCalled();
  });

  it('should prompt EVERY time it is asked — nothing is cached here any more (a repeat is the store\'s business, keyed by subject, not by session)', async () => {
    const confirm = vi.fn(async () => true);
    const prompter = createAskPrompter({ confirm, write: () => undefined });
    await prompter.ask(input);
    await prompter.ask({ ...input, grantId: 'g2' });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('given a declined prompt, should answer not approved', async () => {
    const prompter = createAskPrompter({ confirm: async () => false, write: () => undefined });
    expect(await prompter.ask(input)).toEqual({ approved: false });
  });

  it('given a confirm or scope chooser that throws (terminal closed), should treat it as declined', async () => {
    expect(await createAskPrompter({ confirm: async () => { throw new Error('closed'); }, write: () => undefined }).ask(input)).toEqual({ approved: false });
    expect(await createAskPrompter({ confirm: async () => true, chooseScope: async () => { throw new Error('closed'); }, write: () => undefined }).ask(input)).toEqual({ approved: false });
  });

  it('describeSubject / describeScope read as English', () => {
    expect(describeSubject('exec:/usr/bin/git')).toBe('/usr/bin/git');
    expect(describeSubject('builtin:cd')).toBe('cd (shell builtin)');
    expect(describeSubject('root:/home/u/proj')).toBe('files under /home/u/proj');
    expect(describeScope('once')).toMatch(/only/);
    expect(describeScope('session')).toMatch(/daemon stops/);
    expect(describeScope('30d')).toMatch(/30 days/);
    expect(describeScope('until_revoked')).toMatch(/revoke/);
  });
});
