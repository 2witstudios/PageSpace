import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { HttpError, isPermissionDeniedError, ResponseValidationError } from '../../errors.js';
import {
  askAgent,
  filterModelCatalog,
  listAgents,
  listModels,
  multiDriveListAgents,
  updateAgentConfig,
  type CatalogProvider,
} from '../agents.js';

const config = { baseUrl: 'https://pagespace.ai' };

describe('agents.list — request shape', () => {
  it('interpolates :driveId and sends flags as query params', () => {
    const request = buildRequest(listAgents, { driveId: 'd1', includeSystemPrompt: true, includeTools: false }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1/agents?includeSystemPrompt=true&includeTools=false');
  });

  it('never sends the old tool\'s decorative agentPath/driveSlug fields (stripped by the input schema, not rejected)', () => {
    const parsed = listAgents.inputSchema.safeParse({ driveId: 'd1', agentPath: '/some/path', driveSlug: 'my-drive' });
    expect(parsed.success).toBe(true);
    const request = buildRequest(listAgents, parsed.success ? parsed.data : {}, config);
    expect(request.url).not.toContain('agentPath');
    expect(request.url).not.toContain('driveSlug');
  });
});

describe('agents.list — response contract (route truth: drives/[driveId]/agents/route.ts)', () => {
  const fixture = {
    success: true,
    driveId: 'd1',
    driveName: 'Engineering',
    driveSlug: 'engineering',
    agents: [
      {
        id: 'a1',
        title: 'Support Bot',
        parentId: 'root',
        position: 0,
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-5',
        hasWelcomeMessage: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        hasSystemPrompt: true,
        systemPromptPreview: 'You are a helpful...',
        enabledTools: ['list_pages'],
        enabledToolsCount: 1,
      },
    ],
    count: 1,
    summary: 'Found 1 accessible AI agent(s) in drive "Engineering"',
    stats: { totalInDrive: 1, accessible: 1, withSystemPrompt: 1, withTools: 1 },
    nextSteps: ['Use read_page to view full agent configurations'],
  };

  it('parses the drive agent listing', () => {
    const result = parseResponse(listAgents, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('rejects a response missing a required field', () => {
    const malformed = { ...fixture, agents: [{ ...fixture.agents[0], hasSystemPrompt: undefined }] };
    const result = parseResponse(listAgents, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (no drive access) as a PermissionDeniedError, never a schema mismatch', () => {
    const result = parseResponse(listAgents, 403, new Headers(), JSON.stringify({ error: "You don't have access to this drive" }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect(isPermissionDeniedError(result)).toBe(true);
  });
});

describe('agents.listMultiDrive — request shape', () => {
  it('sends flags as query params with no path params', () => {
    const request = buildRequest(multiDriveListAgents, { groupByDrive: false }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/ai/page-agents/multi-drive?groupByDrive=false');
  });

  it('declares no requiredScope — it enumerates whatever drives the caller can already access', () => {
    expect(multiDriveListAgents.requiredScope).toBeUndefined();
  });
});

describe('agents.listMultiDrive — response contract (route truth: ai/page-agents/multi-drive/route.ts)', () => {
  const baseFixture = {
    success: true,
    totalCount: 2,
    driveCount: 2,
    summary: 'Found 2 accessible AI agent(s) across 2 drive(s)',
    stats: { accessibleDrives: 2, totalAgents: 2, withSystemPrompt: 1, withTools: 2, averageAgentsPerDrive: 1 },
    nextSteps: ['Use ask_agent to consult with specific agents'],
  };
  const agentFixture = {
    id: 'a1',
    title: 'Support Bot',
    parentId: 'root',
    position: 0,
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    hasWelcomeMessage: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    driveId: 'd1',
    driveName: 'Engineering',
    driveSlug: 'engineering',
    hasSystemPrompt: true,
    enabledTools: [],
    enabledToolsCount: 0,
  };

  it('parses the groupByDrive=true shape (agentsByDrive, no top-level agents)', () => {
    const fixture = { ...baseFixture, agentsByDrive: [{ driveId: 'd1', driveName: 'Engineering', driveSlug: 'engineering', agentCount: 1, agents: [agentFixture] }] };
    const result = parseResponse(multiDriveListAgents, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses the groupByDrive=false shape (flat agents, no agentsByDrive)', () => {
    const fixture = { ...baseFixture, agents: [agentFixture] };
    const result = parseResponse(multiDriveListAgents, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });
});

describe('agents.updateConfig — request shape', () => {
  it('interpolates :agentId and sends the rest as a JSON body', () => {
    const request = buildRequest(updateAgentConfig, { agentId: 'a1', systemPrompt: 'Be concise.', aiModel: 'claude-sonnet-5' }, config);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://pagespace.ai/api/ai/page-agents/a1/config');
    expect(request.body).toBe(JSON.stringify({ aiModel: 'claude-sonnet-5', systemPrompt: 'Be concise.' }));
  });

  it('serializes a null enabledTools (explicit clear) distinctly from omitted', () => {
    const request = buildRequest(updateAgentConfig, { agentId: 'a1', enabledTools: null }, config);
    expect(JSON.parse(request.body!)).toEqual({ enabledTools: null });
  });

  it('rejects a toolExposureMode outside upfront/search', () => {
    const result = updateAgentConfig.inputSchema.safeParse({ agentId: 'a1', toolExposureMode: 'always' });
    expect(result.success).toBe(false);
  });
});

describe('agents.updateConfig — response contract (route truth: ai/page-agents/[agentId]/config/route.ts)', () => {
  const fixture = {
    success: true,
    id: 'a1',
    title: 'Support Bot',
    type: 'AI_CHAT',
    message: 'Successfully updated AI agent configuration',
    summary: 'Updated 1 configuration field(s): aiModel',
    updatedFields: ['aiModel'],
    agentConfig: {
      enabledToolsCount: 0,
      enabledTools: [],
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-5',
      hasSystemPrompt: false,
      toolExposureMode: 'upfront',
    },
    stats: { pageType: 'AI_CHAT', updatedFields: 1, configuredTools: 0, hasSystemPrompt: false },
    nextSteps: ['Test the agent to ensure the new configuration works as expected'],
  };

  it('parses the updated agent config', () => {
    const result = parseResponse(updateAgentConfig, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('classifies a 428 expectedRevision-required response as an HttpError, not a schema mismatch', () => {
    const result = parseResponse(updateAgentConfig, 428, new Headers(), JSON.stringify({ error: 'expectedRevision required', currentRevision: 3 }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as HttpError).status).toBe(428);
  });

  it('classifies a 409 revision-mismatch response as an HttpError carrying status 409', () => {
    const result = parseResponse(
      updateAgentConfig,
      409,
      new Headers(),
      JSON.stringify({ error: 'Revision mismatch', currentRevision: 5, expectedRevision: 3 }),
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).status).toBe(409);
  });
});

describe('agents.ask — request shape', () => {
  it('sends agentId/question/context/conversationId as a JSON body to the fixed consult path', () => {
    const request = buildRequest(askAgent, { agentId: 'a1', question: 'What is the plan?', context: 'sprint planning' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/ai/page-agents/consult');
    expect(JSON.parse(request.body!)).toEqual({ agentId: 'a1', context: 'sprint planning', question: 'What is the plan?' });
  });

  it('rejects an empty question', () => {
    expect(askAgent.inputSchema.safeParse({ agentId: 'a1', question: '' }).success).toBe(false);
  });
});

describe('agents.ask — extended timeout + non-idempotency (long-running, non-negotiable)', () => {
  it('declares a timeoutMsOverride well beyond the client default (20-step tool loop, #1769 fix)', () => {
    expect(askAgent.timeoutMsOverride).toBe(120_000);
  });

  it('is a POST — the facade never auto-retries a non-idempotent method (isIdempotentMethod only allows GET)', () => {
    expect(askAgent.method).toBe('POST');
  });
});

describe('agents.ask — response contract (route truth: ai/page-agents/consult/route.ts)', () => {
  const fixture = {
    success: true,
    agent: { id: 'a1', title: 'Support Bot', systemPrompt: 'You are a helpful...', provider: 'anthropic', model: 'claude-sonnet-5', enabledToolsCount: 0 },
    question: 'What is the plan?',
    response: 'The plan is...',
    context: 'sprint planning',
    conversationId: 'conv1',
    metadata: {
      conversationLength: 3,
      toolsAvailable: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      responseLength: 14,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    summary: 'Consulted agent "Support Bot" and received 14 character response',
    nextSteps: ["Review the agent's response for insights"],
  };

  it('parses a successful consultation, including a minted conversationId', () => {
    const result = parseResponse(askAgent, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('accepts a null context (no context was supplied)', () => {
    const withNullContext = { ...fixture, context: null };
    const result = parseResponse(askAgent, 200, new Headers(), JSON.stringify(withNullContext));
    expect(result).toEqual(withNullContext);
  });

  it('classifies a 402 credit-gate denial as an HttpError, never a schema mismatch', () => {
    const result = parseResponse(askAgent, 402, new Headers(), JSON.stringify({ error: 'Insufficient credits' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as HttpError).status).toBe(402);
  });
});

describe('agents.listModels — request shape (D3: no query params reach the route)', () => {
  it('takes no path params and no query string', () => {
    const request = buildRequest(listModels, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/ai/models');
  });

  it('declares no requiredScope — the route is public (D3)', () => {
    expect(listModels.requiredScope).toBeUndefined();
  });
});

describe('agents.listModels — response contract (route truth: ai/models/route.ts, D3)', () => {
  const catalog: CatalogProvider[] = [
    {
      provider: 'anthropic',
      name: 'Anthropic',
      dynamic: false,
      models: [
        { id: 'anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5', provider: 'anthropic', free: false, contextWindow: 200_000 },
        { id: 'anthropic/claude-haiku-4-5', displayName: 'Claude Haiku 4.5', provider: 'anthropic', free: true, contextWindow: 200_000 },
      ],
    },
    {
      provider: 'ollama',
      name: 'Ollama',
      dynamic: true,
      models: [],
    },
  ];
  const fixture = { providers: catalog, defaultProvider: 'anthropic', defaultModel: 'anthropic/claude-sonnet-5' };

  it('parses the provider-grouped catalog with no top-level models array', () => {
    const result = parseResponse(listModels, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
    expect(result).not.toHaveProperty('models');
  });
});

describe('filterModelCatalog — pure client-side D3 replacement', () => {
  const catalog: CatalogProvider[] = [
    {
      provider: 'anthropic',
      name: 'Anthropic',
      dynamic: false,
      models: [
        { id: 'anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5', provider: 'anthropic', free: false },
        { id: 'anthropic/claude-haiku-4-5', displayName: 'Claude Haiku 4.5', provider: 'anthropic', free: true },
      ],
    },
    {
      provider: 'openai',
      name: 'OpenAI',
      dynamic: false,
      models: [{ id: 'openai/gpt-5.3-chat', displayName: 'GPT-5.3 Chat', provider: 'openai', free: false }],
    },
  ];

  it('returns every model flattened with no filter', () => {
    expect(filterModelCatalog(catalog)).toHaveLength(3);
  });

  it('filters to a single provider', () => {
    const result = filterModelCatalog(catalog, { provider: 'openai' });
    expect(result.map((m) => m.id)).toEqual(['openai/gpt-5.3-chat']);
  });

  it('filters to free models only, across providers', () => {
    const result = filterModelCatalog(catalog, { freeOnly: true });
    expect(result.map((m) => m.id)).toEqual(['anthropic/claude-haiku-4-5']);
  });

  it('combines provider and freeOnly filters', () => {
    const result = filterModelCatalog(catalog, { provider: 'anthropic', freeOnly: true });
    expect(result.map((m) => m.id)).toEqual(['anthropic/claude-haiku-4-5']);
  });

  it('returns an empty array when a provider filter matches nothing', () => {
    expect(filterModelCatalog(catalog, { provider: 'google' })).toEqual([]);
  });
});

describe('agents operations — metadata', () => {
  it('every operation is named, described, for MCP/CLI derivation', () => {
    const ops = [listAgents, multiDriveListAgents, updateAgentConfig, askAgent, listModels];
    for (const op of ops) {
      expect(op.name.startsWith('agents.')).toBe(true);
      expect(op.description.length).toBeGreaterThan(0);
    }
  });
});
