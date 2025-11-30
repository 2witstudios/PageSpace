/**
 * Complete Request Builder for AI Chat
 *
 * Builds the complete AI request payload exactly as it would be sent to the LLM.
 * Used by the admin global-prompt viewer to show the exact context window.
 */

import { buildSystemPrompt } from './system-prompt';
import { filterToolsForReadOnly, getToolsSummary } from './tool-filtering';
import { buildTimestampSystemPrompt } from './timestamp-utils';
import { buildMentionSystemPrompt } from './mention-processor';
import {
  buildInlineInstructions,
  buildGlobalAssistantInstructions,
} from './inline-instructions';
import {
  extractToolSchemas,
  type ToolSchemaInfo,
  type JsonSchema,
} from './schema-introspection';
import { estimateSystemPromptTokens } from '@pagespace/lib/ai-context-calculator';
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
    locationContext?: LocationContext;
    modelCapabilities: {
      supportsStreaming: boolean;
      supportsToolCalling: boolean;
      hasVision: boolean;
    };
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

  // Complete system prompt
  const systemPrompt =
    baseSystemPrompt +
    mentionSystemPrompt +
    timestampSystemPrompt +
    inlineInstructions;

  // Get filtered tools based on read-only mode
  const filteredTools = filterToolsForReadOnly(pageSpaceTools, isReadOnly);
  const toolsSummary = getToolsSummary(isReadOnly);

  // Convert tools to the format we display
  const toolsForExtraction: Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { description?: string; parameters?: any }
  > = {};
  for (const [name, tool] of Object.entries(filteredTools)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolAny = tool as any;
    toolsForExtraction[name] = {
      description: toolAny.description,
      parameters: toolAny.parameters,
    };
  }
  const toolSchemas = extractToolSchemas(toolsForExtraction);

  // Convert to ToolDefinition format
  const tools: ToolDefinition[] = toolSchemas.map(
    (schema: ToolSchemaInfo) => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    })
  );

  // Build experimental context
  const experimental_context = {
    userId: '[user-id]',
    locationContext: locationContext || undefined,
    modelCapabilities: {
      supportsStreaming: true,
      supportsToolCalling: true,
      hasVision: false,
    },
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
