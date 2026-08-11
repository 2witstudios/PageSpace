import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from 'ai';
import { handleVoiceBridgeRequest, type VoiceBridgeDeps } from '../bridge-handler';
import type { TranscriptPersistenceDeps } from '../transcript-persistence';

const tool = (execute: () => unknown): Tool =>
  ({
    description: 'Read a page.',
    inputSchema: z.object({ pageId: z.string() }),
    execute,
  }) as unknown as Tool;

const transcriptDeps = (
  over: Partial<TranscriptPersistenceDeps> = {},
): TranscriptPersistenceDeps => ({
  loadConversation: vi.fn(async () => ({
    id: 'conv1',
    userId: 'u1',
    isShared: false,
    type: 'global',
    contextId: null,
    isActive: true,
  })),
  createConversation: vi.fn(async () => undefined),
  canAccess: vi.fn(async () => true),
  saveGlobalMessage: vi.fn(async () => ({ saved: true, rev: 4 })),
  savePageMessage: vi.fn(async () => ({ saved: true, rev: 4 })),
  newMessageId: () => 'msg-1',
  logger: { warn: vi.fn() },
  ...over,
});

const deps = (over: Partial<VoiceBridgeDeps> = {}): VoiceBridgeDeps => ({
  toolDeps: () => ({
    tools: { read_page: tool(() => ({ title: 'Notes' })) },
    logger: { warn: vi.fn(), error: vi.fn() },
  }),
  transcriptDeps: transcriptDeps(),
  model: 'gpt-realtime-2.1',
  ...over,
});

const toolBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'tool',
    callId: 'rtc_1',
    userId: 'u1',
    name: 'read_page',
    argumentsJson: '{"pageId":"p1"}',
    ...over,
  });

const transcriptBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'transcript',
    callId: 'rtc_1',
    userId: 'u1',
    conversationId: 'conv1',
    role: 'user',
    text: 'hello',
    ...over,
  });

describe('handleVoiceBridgeRequest — validation', () => {
  it('given malformed JSON, should 400', async () => {
    const result = await handleVoiceBridgeRequest(deps(), 'not json');
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: 'Invalid JSON' });
  });

  it('given an unknown kind, should 400 rather than guess', async () => {
    const result = await handleVoiceBridgeRequest(deps(), JSON.stringify({ kind: 'delete' }));
    expect(result.status).toBe(400);
  });

  it('given a call id that is not an rtc_ id, should 400', async () => {
    const result = await handleVoiceBridgeRequest(deps(), toolBody({ callId: 'sess_1' }));
    expect(result.status).toBe(400);
  });

  it('given a transcript with no conversation, should 400 — there is nowhere to write it', async () => {
    const result = await handleVoiceBridgeRequest(
      deps(),
      JSON.stringify({
        kind: 'transcript',
        callId: 'rtc_1',
        userId: 'u1',
        role: 'user',
        text: 'hello',
      }),
    );
    expect(result.status).toBe(400);
  });
});

describe('handleVoiceBridgeRequest — tool dispatch', () => {
  it('given a tool call, should run it and answer with a string output', async () => {
    const result = await handleVoiceBridgeRequest(deps(), toolBody());

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, kind: 'tool', output: '{"title":"Notes"}' });
  });

  it('given a tool that fails, should still answer 200 — the model is blocked until it does', async () => {
    // "The tool refused" is not a transport failure. A non-200 here would leave
    // the realtime server with nothing to put in `function_call_output`.
    const result = await handleVoiceBridgeRequest(deps(), toolBody({ name: 'nonexistent' }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, kind: 'tool' });
    expect((result.body as { output: string }).output).toContain('no tool called');
  });

  it('should forward the call context to the dispatcher', async () => {
    const execute = vi.fn(() => 'ok');
    const result = await handleVoiceBridgeRequest(
      deps({
        toolDeps: () => ({
          tools: { read_page: tool(execute) },
          logger: { warn: vi.fn(), error: vi.fn() },
        }),
      }),
      toolBody({
        conversationId: 'conv1',
        timezone: 'America/New_York',
        locationContext: { currentDrive: { id: 'd1', name: 'Work', slug: 'work' } },
      }),
    );

    expect(result.status).toBe(200);
    expect(execute).toHaveBeenCalled();
  });

  it('should build the tool set per request rather than reuse one across calls', async () => {
    // `buildPageSpaceTools` has env-dependent branches; a frozen set would pin
    // whatever the environment looked like at import time.
    const toolDeps = vi.fn(() => ({
      tools: { read_page: tool(() => 'ok') },
      logger: { warn: vi.fn(), error: vi.fn() },
    }));
    const d = deps({ toolDeps });

    await handleVoiceBridgeRequest(d, toolBody());
    await handleVoiceBridgeRequest(d, toolBody());

    expect(toolDeps).toHaveBeenCalledTimes(2);
  });
});

describe('handleVoiceBridgeRequest — transcripts', () => {
  it('given a spoken turn, should persist it and report the post-write rev', async () => {
    const result = await handleVoiceBridgeRequest(deps(), transcriptBody());

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      kind: 'transcript',
      saved: true,
      messageId: 'msg-1',
      rev: 4,
    });
  });

  it('given a refused write, should report saved:false at 200 rather than an error status', async () => {
    // A refusal is an outcome, not a transport failure: the realtime server's
    // only sane response either way is to log it and keep the call up.
    const result = await handleVoiceBridgeRequest(
      deps({ transcriptDeps: transcriptDeps({ canAccess: vi.fn(async () => false) }) }),
      transcriptBody({ userId: 'someone-else' }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, kind: 'transcript', saved: false, messageId: null });
  });
});
