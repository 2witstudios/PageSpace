/**
 * Agent operations (Phase 3 task 5, part 1/2 — old handler `agent.js`):
 * `agents.list`, `agents.listMultiDrive`, `agents.updateConfig`, `agents.ask`,
 * `agents.listModels`. Old MCP tools: `list_agents`, `multi_drive_list_agents`,
 * `update_agent_config`, `ask_agent`, `list_models`
 * (pagespace-mcp/src/handlers/agent.js). Conversation-reading operations live
 * in `conversations.ts` (old handler `conversation.js`).
 *
 * Route-verified against `apps/web/src/app/api/drives/[driveId]/agents/route.ts`
 * GET, `apps/web/src/app/api/ai/page-agents/multi-drive/route.ts` GET,
 * `apps/web/src/app/api/ai/page-agents/[agentId]/config/route.ts` PUT,
 * `apps/web/src/app/api/ai/page-agents/consult/route.ts` POST, and
 * `apps/web/src/app/api/ai/models/route.ts` GET
 * (docs/sdk/operations-inventory.md rows for `update_agent_config`,
 * `list_agents`, `multi_drive_list_agents`, `ask_agent`, `list_models`; D3).
 *
 * `agentPath` from every old tool's input was decorative — verified never
 * sent to any route — and is not part of any operation here.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

// ---------------------------------------------------------------------------
// agents.list — GET /api/drives/:driveId/agents
// ---------------------------------------------------------------------------

const driveAgentSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  parentId: z.string(),
  position: z.number(),
  aiProvider: z.string(),
  aiModel: z.string(),
  hasWelcomeMessage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasSystemPrompt: z.boolean(),
  systemPrompt: z.string().optional(),
  systemPromptPreview: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  enabledToolsCount: z.number().optional(),
});

const listAgentsOutputSchema = z.object({
  success: z.literal(true),
  driveId: z.string(),
  driveName: z.string(),
  driveSlug: z.string(),
  agents: z.array(driveAgentSummarySchema),
  count: z.number(),
  summary: z.string(),
  stats: z.object({
    totalInDrive: z.number(),
    accessible: z.number(),
    withSystemPrompt: z.number(),
    withTools: z.number(),
  }),
  nextSteps: z.array(z.string()),
});

export const listAgents = defineOperation({
  name: 'agents.list',
  method: 'GET',
  path: '/api/drives/:driveId/agents',
  /** Not `.strict()` — deliberately still accepts (and strips) the old tool's decorative `agentPath`/`driveSlug` fields; see the request-shape test. */
  inputSchema: z.object({
    driveId: z.string(),
    includeSystemPrompt: z.boolean().optional(),
    includeTools: z.boolean().optional(),
  }),
  outputSchema: listAgentsOutputSchema,
  requiredScope: 'drive',
  description:
    'List AI agents (AI_CHAT pages) in a drive, filtered to those the caller can view. The old tool\'s `driveSlug` input is ignored by the route (route truth) and is not part of this operation.',
});

// ---------------------------------------------------------------------------
// agents.listMultiDrive — GET /api/ai/page-agents/multi-drive
// ---------------------------------------------------------------------------

const multiDriveAgentSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  parentId: z.string(),
  position: z.number(),
  aiProvider: z.string(),
  aiModel: z.string(),
  hasWelcomeMessage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  driveId: z.string(),
  driveName: z.string(),
  driveSlug: z.string(),
  hasSystemPrompt: z.boolean(),
  systemPrompt: z.string().optional(),
  systemPromptPreview: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  enabledToolsCount: z.number().optional(),
});

const agentsByDriveEntrySchema = z.object({
  driveId: z.string(),
  driveName: z.string(),
  driveSlug: z.string(),
  agentCount: z.number(),
  agents: z.array(multiDriveAgentSummarySchema),
});

const multiDriveListAgentsOutputSchema = z.object({
  success: z.literal(true),
  totalCount: z.number(),
  driveCount: z.number(),
  summary: z.string(),
  stats: z.object({
    accessibleDrives: z.number(),
    totalAgents: z.number(),
    withSystemPrompt: z.number(),
    withTools: z.number(),
    averageAgentsPerDrive: z.number(),
  }),
  nextSteps: z.array(z.string()),
  // Route sends exactly one of these depending on `groupByDrive` (route.ts:193-197).
  agentsByDrive: z.array(agentsByDriveEntrySchema).optional(),
  agents: z.array(multiDriveAgentSummarySchema).optional(),
});

export const multiDriveListAgents = defineOperation({
  name: 'agents.listMultiDrive',
  method: 'GET',
  path: '/api/ai/page-agents/multi-drive',
  inputSchema: z.strictObject({
    includeSystemPrompt: z.boolean().optional(),
    includeTools: z.boolean().optional(),
    groupByDrive: z.boolean().optional(),
  }),
  outputSchema: multiDriveListAgentsOutputSchema,
  // No driveId path param — enumerates whatever drives the caller can already
  // access (same rationale as drives.list / search.multiDrive).
  description:
    'List AI agents across every drive the caller can access. `groupByDrive` (default true server-side) selects between an `agentsByDrive` breakdown and a flat `agents` array.',
});

// ---------------------------------------------------------------------------
// agents.updateConfig — PUT /api/ai/page-agents/:agentId/config
// ---------------------------------------------------------------------------

const toolExposureModeSchema = z.enum(['upfront', 'search']);

const agentConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  enabledToolsCount: z.number(),
  enabledTools: z.array(z.string()),
  aiProvider: z.string(),
  aiModel: z.string(),
  hasSystemPrompt: z.boolean(),
  toolExposureMode: toolExposureModeSchema,
});

const updateAgentConfigOutputSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  title: z.string().nullable(),
  type: z.literal('AI_CHAT'),
  message: z.string(),
  summary: z.string(),
  updatedFields: z.array(z.string()),
  agentConfig: agentConfigSchema,
  stats: z.object({
    pageType: z.literal('AI_CHAT'),
    updatedFields: z.number(),
    configuredTools: z.number(),
    hasSystemPrompt: z.boolean(),
  }),
  nextSteps: z.array(z.string()),
});

export const updateAgentConfig = defineOperation({
  name: 'agents.updateConfig',
  method: 'PUT',
  path: '/api/ai/page-agents/:agentId/config',
  inputSchema: z.strictObject({
    agentId: z.string(),
    systemPrompt: z.string().optional(),
    enabledTools: z.array(z.string()).nullable().optional(),
    aiProvider: z.string().optional(),
    aiModel: z.string().optional(),
    agentDefinition: z.string().nullable().optional(),
    visibleToGlobalAssistant: z.boolean().optional(),
    toolExposureMode: toolExposureModeSchema.optional(),
    expectedRevision: z.number().optional(),
  }),
  outputSchema: updateAgentConfigOutputSchema,
  requiredScope: 'drive',
  description:
    'Update an AI agent\'s configuration (systemPrompt, enabledTools, aiProvider/aiModel, agentDefinition, visibleToGlobalAssistant, toolExposureMode). Route rejects a call with no updatable field (400) and an `expectedRevision` mismatch (409/428) — both surface as a classified HttpError, not a schema mismatch.',
});

// ---------------------------------------------------------------------------
// agents.ask — POST /api/ai/page-agents/consult
// ---------------------------------------------------------------------------

const consultAgentSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  systemPrompt: z.string(),
  provider: z.string(),
  model: z.string(),
  enabledToolsCount: z.number(),
});

const askAgentOutputSchema = z.object({
  success: z.literal(true),
  agent: consultAgentSummarySchema,
  question: z.string(),
  response: z.string(),
  context: z.string().nullable(),
  conversationId: z.string(),
  metadata: z.object({
    conversationLength: z.number(),
    toolsAvailable: z.number(),
    provider: z.string(),
    model: z.string(),
    responseLength: z.number(),
    timestamp: z.string(),
  }),
  summary: z.string(),
  nextSteps: z.array(z.string()),
});

export const askAgent = defineOperation({
  name: 'agents.ask',
  method: 'POST',
  path: '/api/ai/page-agents/consult',
  inputSchema: z.strictObject({
    agentId: z.string(),
    question: z.string().min(1),
    context: z.string().optional(),
    conversationId: z.string().optional(),
  }),
  outputSchema: askAgentOutputSchema,
  requiredScope: 'drive',
  // Long-running: the route's tool loop is capped at 20 steps (#1769 fix,
  // mirroring the internal ask_agent tool's own budget) inside one
  // generateText call — comfortably covered by 2 minutes without masking a
  // genuinely hung request.
  timeoutMsOverride: 120_000,
  description:
    'Consult another AI agent for specialized assistance. Non-idempotent: POST is never auto-retried by the facade (isIdempotentMethod only retries GET), so a timeout or 5xx is surfaced directly rather than retried — a retried ask would double-execute the agent. Omitting `conversationId` falls back to the agent\'s 10 most recent messages across all conversations (#1769 fix); passing one continues that exact conversation.',
});

// ---------------------------------------------------------------------------
// agents.listModels — GET /api/ai/models (D3)
// ---------------------------------------------------------------------------

const catalogModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: z.string(),
  free: z.boolean(),
  contextWindow: z.number().optional(),
});

const catalogProviderSchema = z.object({
  provider: z.string(),
  name: z.string(),
  dynamic: z.boolean(),
  models: z.array(catalogModelSchema),
});

const listModelsOutputSchema = z.object({
  providers: z.array(catalogProviderSchema),
  defaultProvider: z.string(),
  defaultModel: z.string(),
});

export const listModels = defineOperation({
  name: 'agents.listModels',
  method: 'GET',
  path: '/api/ai/models',
  inputSchema: z.strictObject({}),
  outputSchema: listModelsOutputSchema,
  description:
    'List the AI model catalog grouped by provider (D3: the route is public, takes no query params, and returns no top-level `models` array — the old tool\'s provider/freeOnly filtering was dead code). Filter the fetched catalog client-side with `filterModelCatalog`.',
});

export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;

export interface ModelCatalogFilter {
  readonly provider?: string;
  readonly freeOnly?: boolean;
}

/**
 * D3's resolution: `list_models`' `provider`/`freeOnly` filtering moves
 * client-side since the route ignores both query params. Pure — filters an
 * already-fetched catalog, never touches the network.
 */
export function filterModelCatalog(
  catalog: readonly CatalogProvider[],
  filter: ModelCatalogFilter = {},
): CatalogModel[] {
  const providers = filter.provider ? catalog.filter((p) => p.provider === filter.provider) : catalog;
  return providers.flatMap((p) => (filter.freeOnly ? p.models.filter((m) => m.free) : p.models));
}
