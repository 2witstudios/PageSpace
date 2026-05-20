/**
 * Complete Request Builder for AI Chat
 *
 * Builds the complete AI request payload exactly as it would be sent to the LLM.
 * Used by the admin global-prompt viewer to show the exact context window.
 */

import { buildSystemPrompt, buildNonCoreToolNamesPrompt } from './system-prompt';
import { filterToolsForReadOnly, isWriteTool } from './tool-filtering';
import { CORE_TOOL_NAMES } from './stub-tools';
import { buildTimestampSystemPrompt } from './timestamp-utils';
import { buildMentionSystemPrompt } from './mention-processor';
import {
  buildInlineInstructions,
  buildGlobalAssistantInstructions,
} from './inline-instructions';
import {
  extractToolSchemas,
  type ToolDefinitionForExtraction,
  type ToolSchemaInfo,
  type JsonSchema,
} from './schema-introspection';
import { estimateSystemPromptTokens } from '@pagespace/lib/monitoring/ai-context-calculator';
import { pageSpaceTools } from './ai-tools';

export interface LocationContext {
  currentPage?: {
    id: string;
    title: string;
    type: string;
    path: string;
    isTaskLinked?: boolean;
  };
  currentDrive?: {
    id: string;
    name: string;
    slug: string;
  };
  breadcrumbs?: Array<{ id: string; title: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface CompleteAIRequest {
  model: string;
  system: string;
  tools: ToolDefinition[];
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  experimental_context: {
    userId: string;
    timezone: string | undefined;
    aiProvider: string;
    aiModel: string;
    conversationId: string;
    locationContext?: LocationContext;
    modelCapabilities: {
      hasVision: boolean;
      hasTools: boolean;
      model: string;
      provider: string;
    };
    chatSource: {
      type: 'global';
    };
    enabledTools: string[] | null;
  };
}

export interface CompletePayloadResult {
  request: CompleteAIRequest;
  formattedString: string;
  tokenEstimates: {
    systemPrompt: number;
    tools: number;
    experimentalContext: number;
    total: number;
  };
  toolsSummary: {
    allowed: string[];
    denied: string[];
  };
  nonCoreToolNames: string[];
}

interface BuildCompleteRequestConfig {
  isReadOnly?: boolean;
  contextType: 'dashboard' | 'drive' | 'page';
  locationContext?: LocationContext;
  model?: string;
  includeExampleMessage?: boolean;
}

/**
 * Build the complete AI request payload.
 */
export function buildCompleteRequest(
  config: BuildCompleteRequestConfig
): CompletePayloadResult {
  const {
    isReadOnly = false,
    contextType,
    locationContext,
    model = 'openrouter/anthropic/claude-sonnet-4',
    includeExampleMessage = true,
  } = config;

  // Build the base system prompt
  const baseSystemPrompt = buildSystemPrompt(
    contextType,
    locationContext?.currentDrive
      ? {
          driveName: locationContext.currentDrive.name,
          driveSlug: locationContext.currentDrive.slug,
          driveId: locationContext.currentDrive.id,
          pagePath: locationContext.currentPage?.path,
          pageType: locationContext.currentPage?.type,
          breadcrumbs: locationContext.breadcrumbs?.map((b) => b.title),
        }
      : undefined,
    isReadOnly
  );

  // Build additional prompt sections
  const timestampSystemPrompt = buildTimestampSystemPrompt();
  const mentionSystemPrompt = buildMentionSystemPrompt([
    { id: 'example-page-id', label: 'Example Document', type: 'page' },
  ]);

  // Build inline instructions based on context type
  let inlineInstructions: string;
  if (contextType === 'page' && locationContext?.currentPage) {
    inlineInstructions = buildInlineInstructions({
      pageTitle: locationContext.currentPage.title,
      pageType: locationContext.currentPage.type,
      isTaskLinked: locationContext.currentPage.isTaskLinked,
      driveName: locationContext.currentDrive?.name,
      pagePath: locationContext.currentPage.path,
      driveSlug: locationContext.currentDrive?.slug,
      driveId: locationContext.currentDrive?.id,
    });
  } else {
    inlineInstructions = buildGlobalAssistantInstructions(
      locationContext?.currentDrive
        ? {
            driveName: locationContext.currentDrive.name,
            driveSlug: locationContext.currentDrive.slug,
            driveId: locationContext.currentDrive.id,
          }
        : undefined
    );
  }

  // Apply read-only filtering (same logic as real Global Assistant)
  const allFilteredTools = filterToolsForReadOnly(pageSpaceTools, isReadOnly);

  // Core tools get full schemas upfront; non-core tools are accessible via execute_tool
  const coreFilteredTools = Object.fromEntries(
    Object.entries(allFilteredTools).filter(([name]) => CORE_TOOL_NAMES.has(name))
  );
  const nonCoreToolNames = Object.keys(allFilteredTools).filter(n => !CORE_TOOL_NAMES.has(n));

  // Append non-core tool names to system prompt (matches real Global Assistant behavior)
  const nonCoreNamesSection = buildNonCoreToolNamesPrompt(nonCoreToolNames);

  // Complete system prompt (with non-core tool names section, matching real Global Assistant)
  const systemPrompt =
    baseSystemPrompt +
    mentionSystemPrompt +
    timestampSystemPrompt +
    inlineInstructions +
    (nonCoreNamesSection ? '\n\n' + nonCoreNamesSection : '');

  // Build core tool schemas
  const coreToolsForExtraction: Record<string, ToolDefinitionForExtraction> = {};
  for (const [name, tool] of Object.entries(coreFilteredTools)) {
    coreToolsForExtraction[name] = {
      description: tool.description,
      parameters: tool.inputSchema,
    };
  }
  const coreToolSchemas = extractToolSchemas(coreToolsForExtraction);

  // tool_search and execute_tool are added dynamically at runtime; represent them with static schemas
  const toolSearchJsonSchema = {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'Either "select:name1,name2" for specific tools or a search keyword',
      },
    },
    required: ['query'],
  };
  const executeToolJsonSchema = {
    type: 'object' as const,
    properties: {
      tool_name: { type: 'string' as const },
      parameters: { type: 'object' as const, properties: {}, required: [] },
    },
    required: ['tool_name'],
  };

  const toolSchemas: ToolSchemaInfo[] = [
    ...coreToolSchemas,
    {
      name: 'tool_search',
      description:
        'Get full parameter schemas for any PageSpace tool before calling it. Use "select:name1,name2" for specific tools by name, or a keyword like "calendar", "agent", "task", "channel", "drive" to find all tools in that area.',
      parameters: toolSearchJsonSchema,
      tokenEstimate: estimateSystemPromptTokens(
        JSON.stringify({ name: 'tool_search', parameters: toolSearchJsonSchema })
      ),
    },
    {
      name: 'execute_tool',
      description:
        'Execute any PageSpace tool by name. Call tool_search first to discover available tools and get their parameter schemas.',
      parameters: executeToolJsonSchema,
      tokenEstimate: estimateSystemPromptTokens(
        JSON.stringify({ name: 'execute_tool', parameters: executeToolJsonSchema })
      ),
    },
  ];

  // Convert to ToolDefinition format
  const tools: ToolDefinition[] = toolSchemas.map(
    (schema: ToolSchemaInfo) => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    })
  );

  // Tool summary: upfront tools for this mode (core filtered by read-only + tool_search + execute_tool)
  const coreAllowedNames = Object.keys(coreFilteredTools);
  const toolsSummary = {
    allowed: [...coreAllowedNames, 'tool_search', 'execute_tool'],
    denied: isReadOnly ? Array.from(CORE_TOOL_NAMES).filter(n => isWriteTool(n)) : [],
  };

  // Build experimental context matching the real chat route shape
  const experimental_context = {
    userId: '[user-id]',
    timezone: undefined as string | undefined,
    aiProvider: '[varies by chat]',
    aiModel: '[varies by chat]',
    conversationId: '[generated per conversation]',
    locationContext: locationContext || undefined,
    modelCapabilities: {
      hasVision: false,
      hasTools: true,
      model: '[varies by chat]',
      provider: '[varies by chat]',
    },
    chatSource: {
      type: 'global' as const,
    },
    enabledTools: null as string[] | null,
  };

  // Build example messages
  const messages: CompleteAIRequest['messages'] = includeExampleMessage
    ? [{ role: 'user' as const, content: 'What documents are in this drive?' }]
    : [];

  // Build the complete request object
  const request: CompleteAIRequest = {
    model,
    system: systemPrompt,
    tools,
    messages,
    experimental_context,
  };

  // Calculate token estimates
  const systemPromptTokens = estimateSystemPromptTokens(systemPrompt);
  const toolTokens = toolSchemas.reduce(
    (sum: number, t: ToolSchemaInfo) => sum + t.tokenEstimate,
    0
  );
  const contextTokens = estimateSystemPromptTokens(
    JSON.stringify(experimental_context)
  );

  const tokenEstimates = {
    systemPrompt: systemPromptTokens,
    tools: toolTokens,
    experimentalContext: contextTokens,
    total: systemPromptTokens + toolTokens + contextTokens,
  };

  // Format as a human-readable string
  const formattedString = formatCompletePayload(
    request,
    tokenEstimates,
    isReadOnly
  );

  return {
    request,
    formattedString,
    tokenEstimates,
    toolsSummary,
    nonCoreToolNames,
  };
}

/**
 * Format the complete request as a human-readable string.
 */
function formatCompletePayload(
  request: CompleteAIRequest,
  tokenEstimates: {
    systemPrompt: number;
    tools: number;
    experimentalContext: number;
    total: number;
  },
  isReadOnly: boolean
): string {
  const divider = '═'.repeat(70);
  const sectionDivider = '─'.repeat(70);

  const toolsJson = request.tools
    .map((tool) => JSON.stringify(tool, null, 2))
    .join('\n\n');
  const contextJson = JSON.stringify(request.experimental_context, null, 2);
  const messagesJson = JSON.stringify(request.messages, null, 2);

  const modeLabel = isReadOnly ? 'READ-ONLY' : 'FULL ACCESS';

  return `${divider}
COMPLETE AI REQUEST PAYLOAD
Model: ${request.model}
Mode: ${modeLabel}
Total Estimated Tokens: ~${tokenEstimates.total.toLocaleString()}
${divider}

─── SYSTEM PROMPT (${tokenEstimates.systemPrompt.toLocaleString()} tokens) ${sectionDivider.slice(45)}

${request.system}

─── TOOLS (${request.tools.length} available, ${tokenEstimates.tools.toLocaleString()} tokens) ${sectionDivider.slice(50)}

${toolsJson}

─── EXPERIMENTAL CONTEXT (${tokenEstimates.experimentalContext.toLocaleString()} tokens) ${sectionDivider.slice(55)}

${contextJson}

─── MESSAGE FORMAT (Example) ${sectionDivider.slice(30)}

${messagesJson}

${divider}
END OF PAYLOAD
${divider}`;
}

/**
 * Build payload for both modes for comparison.
 */
export function buildBothModePayloads(
  contextType: 'dashboard' | 'drive' | 'page',
  locationContext?: LocationContext
): { fullAccess: CompletePayloadResult; readOnly: CompletePayloadResult } {
  return {
    fullAccess: buildCompleteRequest({
      isReadOnly: false,
      contextType,
      locationContext,
    }),
    readOnly: buildCompleteRequest({
      isReadOnly: true,
      contextType,
      locationContext,
    }),
  };
}
