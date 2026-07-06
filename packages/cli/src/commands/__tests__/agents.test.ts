import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  agentsAskHandler,
  agentsConfigHandler,
  agentsListHandler,
  modelsListHandler,
  parseArgv,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { TimeoutError } from '@pagespace/sdk';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const DRIVE_AGENT = {
  id: 'ag1',
  title: 'Support Bot',
  parentId: 'root',
  position: 0,
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-5',
  hasWelcomeMessage: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  hasSystemPrompt: true,
};

const LIST_RESULT = {
  success: true as const,
  driveId: 'd1',
  driveName: 'Engineering',
  driveSlug: 'engineering',
  agents: [DRIVE_AGENT],
  count: 1,
  summary: 'Found 1 agent',
  stats: { totalInDrive: 1, accessible: 1, withSystemPrompt: 1, withTools: 0 },
  nextSteps: [],
};

const MULTI_DRIVE_AGENT = { ...DRIVE_AGENT, driveId: 'd1', driveName: 'Engineering', driveSlug: 'engineering' };

const MULTI_DRIVE_LIST_RESULT = {
  success: true as const,
  totalCount: 1,
  driveCount: 1,
  summary: 'Found 1 agent across 1 drive',
  stats: { accessibleDrives: 1, totalAgents: 1, withSystemPrompt: 1, withTools: 0, averageAgentsPerDrive: 1 },
  nextSteps: [],
  agents: [MULTI_DRIVE_AGENT],
};

const ASK_RESULT = {
  success: true as const,
  agent: { id: 'ag1', title: 'Support Bot', systemPrompt: 'Be helpful.', provider: 'anthropic', model: 'claude-sonnet-5', enabledToolsCount: 2 },
  question: 'What is the refund policy?',
  response: 'Refunds are processed within 5 business days.',
  context: null,
  conversationId: 'conv1',
  metadata: {
    conversationLength: 2,
    toolsAvailable: 2,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    responseLength: 44,
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  summary: 'Consulted agent Support Bot',
  nextSteps: [],
};

const UPDATE_CONFIG_RESULT = {
  success: true as const,
  id: 'ag1',
  title: 'Support Bot',
  type: 'AI_CHAT' as const,
  message: 'Updated',
  summary: 'Updated 1 field',
  updatedFields: ['aiModel'],
  agentConfig: {
    systemPrompt: 'Be helpful.',
    enabledToolsCount: 2,
    enabledTools: ['search'],
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    hasSystemPrompt: true,
    toolExposureMode: 'upfront' as const,
  },
  stats: { pageType: 'AI_CHAT' as const, updatedFields: 1, configuredTools: 1, hasSystemPrompt: true },
  nextSteps: [],
};

const MODELS_RESULT = {
  providers: [
    {
      provider: 'anthropic',
      name: 'Anthropic',
      dynamic: false,
      models: [
        { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', provider: 'anthropic', free: false },
        { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', provider: 'anthropic', free: true, contextWindow: 200000 },
      ],
    },
  ],
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-5',
};

// ---------------------------------------------------------------------------
// agents list -> agents.list / agents.listMultiDrive
// ---------------------------------------------------------------------------

describe('agentsListHandler', () => {
  it('exits 2 with a usage error when neither --drive nor --all-drives is given', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { list } }) });

    const code = await agentsListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(list).not.toHaveBeenCalled();
  });

  it('exits 2 when both --drive and --all-drives are given (mutually exclusive)', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { list } }) });

    const code = await agentsListHandler(ctx, commandIntent(['--drive', 'd1', '--all-drives']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(list).not.toHaveBeenCalled();
  });

  it('calls agents.list with the given driveId', async () => {
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { list } }) });

    const code = await agentsListHandler(ctx, commandIntent(['--drive', 'd1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({ driveId: 'd1' });
  });

  it('calls agents.listMultiDrive when --all-drives is given', async () => {
    const listMultiDrive = vi.fn(async () => MULTI_DRIVE_LIST_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { listMultiDrive } }) });

    const code = await agentsListHandler(ctx, commandIntent(['--all-drives']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(listMultiDrive).toHaveBeenCalledWith({});
  });

  it('renders one line per agent for a single drive', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { list: async () => LIST_RESULT } }) });

    await agentsListHandler(ctx, commandIntent(['--drive', 'd1']));

    expect(stdout.lines.join('')).toBe('ag1  Support Bot  [anthropic/claude-sonnet-5]\n');
  });

  it('renders drive-prefixed lines across drives for --all-drives', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { listMultiDrive: async () => MULTI_DRIVE_LIST_RESULT } }) });

    await agentsListHandler(ctx, commandIntent(['--all-drives']));

    expect(stdout.lines.join('')).toBe('engineering:ag1  Support Bot  [anthropic/claude-sonnet-5]\n');
  });

  it('renders "No agents." when the drive has none', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { list: async () => ({ ...LIST_RESULT, agents: [] }) } }) });

    await agentsListHandler(ctx, commandIntent(['--drive', 'd1']));

    expect(stdout.lines.join('')).toBe('No agents.\n');
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { list: async () => LIST_RESULT } }) });

    const code = await agentsListHandler(ctx, commandIntent(['--drive', 'd1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(LIST_RESULT);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const list = vi.fn(async () => {
      throw new Error('Drive not found');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ agents: { list } }) });

    const code = await agentsListHandler(ctx, commandIntent(['--drive', 'd1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Drive not found');
  });
});

// ---------------------------------------------------------------------------
// agents ask -> agents.ask
// ---------------------------------------------------------------------------

describe('agentsAskHandler', () => {
  it('exits 2 with a usage error when the message is missing', async () => {
    const ask = vi.fn(async () => ASK_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { ask } }) });

    const code = await agentsAskHandler(ctx, commandIntent(['ag1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(ask).not.toHaveBeenCalled();
  });

  it('calls agents.ask with agentId + question', async () => {
    const ask = vi.fn(async () => ASK_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { ask } }) });

    const code = await agentsAskHandler(ctx, commandIntent(['ag1', 'What is the refund policy?']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(ask).toHaveBeenCalledWith({ agentId: 'ag1', question: 'What is the refund policy?', context: undefined, conversationId: undefined });
  });

  it('passes --conversation-id and --context through', async () => {
    const ask = vi.fn(async () => ASK_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { ask } }) });

    await agentsAskHandler(ctx, commandIntent(['ag1', 'follow up', '--conversation-id', 'conv1', '--context', 'ticket #42']));

    expect(ask).toHaveBeenCalledWith({ agentId: 'ag1', question: 'follow up', context: 'ticket #42', conversationId: 'conv1' });
  });

  it('renders the plain-text response (agents.ask has no parts array — a flat response string)', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { ask: async () => ASK_RESULT } }) });

    await agentsAskHandler(ctx, commandIntent(['ag1', 'What is the refund policy?']));

    expect(stdout.lines.join('')).toBe('Refunds are processed within 5 business days.\n\n(conversationId: conv1)\n');
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { ask: async () => ASK_RESULT } }) });

    const code = await agentsAskHandler(ctx, commandIntent(['ag1', 'q', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(ASK_RESULT);
  });

  it('exits 1 and surfaces the server error on a non-timeout API failure', async () => {
    const stderr = createRecordingSink();
    const ask = vi.fn(async () => {
      throw new Error('Agent not found');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ agents: { ask } }) });

    const code = await agentsAskHandler(ctx, commandIntent(['ag1', 'q']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Agent not found');
  });

  it('renders an honest "may still have run" message on timeout, never auto-retrying', async () => {
    const stderr = createRecordingSink();
    const ask = vi.fn(async () => {
      throw new TimeoutError('timed out');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ agents: { ask } }) });

    const code = await agentsAskHandler(ctx, commandIntent(['ag1', 'q']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stderr.lines.join('')).toContain('may still be running');
    expect(stderr.lines.join('')).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// agents config -> agents.updateConfig
// ---------------------------------------------------------------------------

describe('agentsConfigHandler', () => {
  it('exits 2 with a usage error when agentPageId is missing', async () => {
    const updateConfig = vi.fn(async () => UPDATE_CONFIG_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { updateConfig } }) });

    const code = await agentsConfigHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when no --set flag is given', async () => {
    const updateConfig = vi.fn(async () => UPDATE_CONFIG_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { updateConfig } }) });

    const code = await agentsConfigHandler(ctx, commandIntent(['ag1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('maps a single --set key=value to the matching updateConfig field', async () => {
    const updateConfig = vi.fn(async () => UPDATE_CONFIG_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { updateConfig } }) });

    const code = await agentsConfigHandler(ctx, commandIntent(['ag1', '--set', 'aiModel=claude-sonnet-5']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(updateConfig).toHaveBeenCalledWith({ agentId: 'ag1', aiModel: 'claude-sonnet-5' });
  });

  it('merges repeated --set flags and JSON-coerces non-string values', async () => {
    const updateConfig = vi.fn(async () => UPDATE_CONFIG_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { updateConfig } }) });

    await agentsConfigHandler(
      ctx,
      commandIntent([
        'ag1',
        '--set',
        'aiModel=claude-sonnet-5',
        '--set',
        'enabledTools=["search","glob"]',
        '--set',
        'visibleToGlobalAssistant=true',
      ]),
    );

    expect(updateConfig).toHaveBeenCalledWith({
      agentId: 'ag1',
      aiModel: 'claude-sonnet-5',
      enabledTools: ['search', 'glob'],
      visibleToGlobalAssistant: true,
    });
  });

  it('does not maintain its own key allowlist — forwards an unrecognized --set key as-is and lets the server/schema reject it', async () => {
    const updateConfig = vi.fn(async () => UPDATE_CONFIG_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { updateConfig } }) });

    await agentsConfigHandler(ctx, commandIntent(['ag1', '--set', 'notARealField=x']));

    expect(updateConfig).toHaveBeenCalledWith({ agentId: 'ag1', notARealField: 'x' });
  });

  it('exits 2 for a malformed --set value with no "="', async () => {
    const updateConfig = vi.fn(async () => UPDATE_CONFIG_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { updateConfig } }) });

    const code = await agentsConfigHandler(ctx, commandIntent(['ag1', '--set', 'aiModel']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { updateConfig: async () => UPDATE_CONFIG_RESULT } }) });

    const code = await agentsConfigHandler(ctx, commandIntent(['ag1', '--set', 'aiModel=claude-sonnet-5', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(UPDATE_CONFIG_RESULT);
  });

  it("exits 1 and renders the server's validation error verbatim", async () => {
    const stderr = createRecordingSink();
    const updateConfig = vi.fn(async () => {
      throw new Error('No updatable field provided');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ agents: { updateConfig } }) });

    const code = await agentsConfigHandler(ctx, commandIntent(['ag1', '--set', 'notARealField=x']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('No updatable field provided');
  });
});

// ---------------------------------------------------------------------------
// models list -> agents.listModels
// ---------------------------------------------------------------------------

describe('modelsListHandler', () => {
  it('exits 2 with a usage error given any positional args', async () => {
    const listModels = vi.fn(async () => MODELS_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { listModels } }) });

    const code = await modelsListHandler(ctx, commandIntent(['extra']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('calls agents.listModels with no arguments', async () => {
    const listModels = vi.fn(async () => MODELS_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ agents: { listModels } }) });

    const code = await modelsListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_SUCCESS);
    expect(listModels).toHaveBeenCalledWith({});
  });

  it('renders one line per model, grouped by provider, marking free models', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { listModels: async () => MODELS_RESULT } }) });

    await modelsListHandler(ctx, commandIntent([]));

    expect(stdout.lines.join('')).toBe(
      'anthropic:claude-sonnet-5  Claude Sonnet 5\nanthropic:claude-haiku-4-5  Claude Haiku 4.5  [free]\n',
    );
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ agents: { listModels: async () => MODELS_RESULT } }) });

    const code = await modelsListHandler(ctx, commandIntent(['--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(MODELS_RESULT);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const listModels = vi.fn(async () => {
      throw new Error('Service unavailable');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ agents: { listModels } }) });

    const code = await modelsListHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Service unavailable');
  });
});
