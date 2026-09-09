/**
 * GA wave 2, leaf 5 — `request_env_approval`: client-side (no execute),
 * injected only when the session is bound to a local env, kept out of
 * baseTools / tool_search / execute_tool with the same discipline as
 * ask_user — and never a reuse of ask_user, whose answers are model-visible
 * text rather than an authorization artefact.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envApprovalTools, REQUEST_ENV_APPROVAL_TOOL_NAME, requestEnvApprovalInputSchema, requestEnvApprovalOutputSchema } from '../env-approval-tools';
import { buildPageSpaceTools } from '@/lib/ai/core/ai-tools';

const read = (relative: string) => readFileSync(join(__dirname, '..', '..', '..', '..', relative), 'utf8');

describe('the tool definition', () => {
  it('has no execute — the turn pauses and resumes on the owner\'s click', () => {
    expect('execute' in envApprovalTools[REQUEST_ENV_APPROVAL_TOOL_NAME]).toBe(false);
    expect(REQUEST_ENV_APPROVAL_TOOL_NAME).toBe('request_env_approval');
  });

  it('tells the model to STOP after calling it and to pass the challengeId verbatim', () => {
    const description = envApprovalTools[REQUEST_ENV_APPROVAL_TOOL_NAME].description ?? '';
    expect(description).toMatch(/STOP/);
    expect(description).toMatch(/challengeId/);
    expect(description).toMatch(/local_approval_required/);
  });

  it('is NOT in the base registry (never in tool_search or execute_tool), for every registry shape', () => {
    for (const codeExecutionEnabled of [true, false]) {
      expect(Object.keys(buildPageSpaceTools({ codeExecutionEnabled }))).not.toContain(REQUEST_ENV_APPROVAL_TOOL_NAME);
    }
  });

  it('input is a single challengeId; output is the closed outcome set with capped strings', () => {
    expect(requestEnvApprovalInputSchema.safeParse({ challengeId: 'ch_1' }).success).toBe(true);
    expect(requestEnvApprovalInputSchema.safeParse({ challengeId: '' }).success).toBe(false);
    expect(requestEnvApprovalInputSchema.safeParse({}).success).toBe(false);
    expect(requestEnvApprovalOutputSchema.safeParse({ challengeId: 'ch_1', outcome: 'allowed', exitCode: 0, stdout: 'ok', stderr: '', truncated: false }).success).toBe(true);
    expect(requestEnvApprovalOutputSchema.safeParse({ challengeId: 'ch_1', outcome: 'denied' }).success).toBe(true);
    expect(requestEnvApprovalOutputSchema.safeParse({ challengeId: 'ch_1', outcome: 'maybe' }).success).toBe(false);
    expect(requestEnvApprovalOutputSchema.safeParse({ challengeId: 'ch_1', outcome: 'allowed', isAdmin: true }).success).toBe(false);
    expect(requestEnvApprovalOutputSchema.safeParse({ challengeId: 'ch_1', outcome: 'allowed', stdout: 'x'.repeat(200_001) }).success).toBe(false);
  });
});

describe('not ask_user — pinned by reading the source', () => {
  it('env-approval-tools.ts and the card never import the ask_user tool module', () => {
    expect(read('lib/ai/tools/env-approval-tools.ts')).not.toMatch(/ask-user-tools/);
    expect(read('components/ai/shared/chat/env-approval/EnvApprovalCard.tsx')).not.toMatch(/ask-user-tools|ASK_USER_TOOL_NAME|askUser/);
  });

  it('the card renders the FROZEN request fetched from the approvals route, never the tool input', () => {
    const card = read('components/ai/shared/chat/env-approval/EnvApprovalCard.tsx');
    expect(card).toMatch(/\/api\/env-bridge\/approvals\//);
    for (const field of ['principal', 'op', 'command', 'cwd', 'paths', 'env', 'limits']) expect(card, field).toContain(`'${field}'`);
  });
});

describe('route-level injection — the same discipline as ask_user, gated on a LOCAL env binding', () => {
  it.each(['lib/ai/chat-pipeline/page-chat-turn.ts', 'lib/ai/chat-pipeline/global-chat-turn.ts'])('%s spreads envApprovalTools ONLY inside the local-env guard, after the ask_user injection, and pauses on it', (file) => {
    const source = read(file);
    expect(source).toMatch(/resolveLocalEnvBindingForConversation\(/);
    const guard = source.indexOf('if (localEnvBinding !== null) {');
    const spread = source.indexOf('...envApprovalTools');
    const askUser = source.indexOf('...askUserTools');
    expect(guard).toBeGreaterThan(-1);
    expect(spread).toBeGreaterThan(guard);
    expect(spread - guard).toBeLessThan(400);
    expect(askUser).toBeLessThan(spread);
    // Exactly one spread: never a second, unguarded one.
    expect(source.split('...envApprovalTools').length).toBe(2);
    expect(source).toMatch(/pauseToolNames\.push\(REQUEST_ENV_APPROVAL_TOOL_NAME\)/);
    expect(source).toMatch(/\.\.\.pauseToolNames\.map\(\(name\) => hasToolCall\(name\)\)/);
  });

  it('the base registry builder never mentions it (no accidental catalog entry)', () => {
    expect(read('lib/ai/core/ai-tools.ts')).not.toMatch(/env-approval-tools|request_env_approval/);
  });
});
