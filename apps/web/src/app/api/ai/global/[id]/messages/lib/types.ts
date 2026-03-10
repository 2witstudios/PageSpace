import type { UIMessage, ToolSet, LanguageModel } from 'ai';
import type { ProviderRequest, ProviderResult } from '@/lib/ai/core/provider-factory';
import type { MCPTool } from '@/types/mcp';

export type { ToolSet } from 'ai';

export interface LocationContext {
  currentPage?: {
    id: string;
    title: string;
    type: string;
    path: string;
  };
  currentDrive?: {
    id: string;
    name: string;
    slug: string;
  };
  breadcrumbs?: string[];
}

export interface PostRequestBody {
  messages: UIMessage[];
  selectedProvider?: string;
  selectedModel?: string;
  openRouterApiKey?: string;
  googleApiKey?: string;
  openAIApiKey?: string;
  anthropicApiKey?: string;
  xaiApiKey?: string;
  ollamaBaseUrl?: string;
  glmApiKey?: string;
  locationContext?: LocationContext;
  isReadOnly?: boolean;
  webSearchEnabled?: boolean;
  showPageTree?: boolean;
  mcpTools?: MCPTool[];
}

export interface ValidatedContext {
  userId: string;
  conversationId: string;
  conversation: {
    id: string;
    userId: string;
    isActive: boolean;
    title: string | null;
    type: string;
    contextId: string | null;
  };
}

export interface ConversationHistory {
  dbMessages: Array<{
    id: string;
    conversationId: string;
    userId: string;
    role: string;
    content: string;
    toolCalls: unknown;
    toolResults: unknown;
    createdAt: Date;
    isActive: boolean;
    editedAt: Date | null;
  }>;
  uiMessages: UIMessage[];
  sanitizedMessages: UIMessage[];
  processedMessages: UIMessage[];
  modelMessages: ReturnType<typeof import('ai').convertToModelMessages> extends Promise<infer T> ? T : never;
}

export interface SystemPromptContext {
  basePrompt: string;
  mentionPrompt: string;
  timestampPrompt: string;
  globalAssistantPrompt: string;
  drivePrompt: string;
  agentAwarenessPrompt: string;
  pageTreePrompt: string;
  finalPrompt: string;
}

export interface ToolsContext {
  finalTools: ToolSet;
  pageSpaceToolCount: number;
  integrationToolCount: number;
  mcpToolCount: number;
}

export interface StreamContext {
  model: LanguageModel;
  provider: string;
  modelName: string;
  userId: string;
  conversationId: string;
  userTimezone: string;
  locationContext?: LocationContext;
  systemPrompt: string;
  messages: ConversationHistory['modelMessages'];
  tools: ToolSet;
  readOnlyMode: boolean;
  serverAssistantMessageId: string;
  contextCalculation: {
    totalTokens: number;
    messageCount: number;
    systemPromptTokens: number;
    toolDefinitionTokens: number;
    conversationTokens: number;
    messageIds: string[];
    wasTruncated: boolean;
    truncationStrategy?: string;
  };
}

export interface UsageTrackingParams {
  userId: string;
  provider: string;
  modelName: string;
  conversationId: string;
  messageId: string;
  startTime: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextCalculation: StreamContext['contextCalculation'];
  toolCallsCount: number;
  toolResultsCount: number;
  readOnlyMode: boolean;
}

export interface PostRequestValidation {
  body: PostRequestBody;
  userMessage: UIMessage;
  conversationId: string;
  readOnlyMode: boolean;
  webSearchMode: boolean;
}

export interface ProviderContext {
  model: LanguageModel;
  provider: string;
  modelName: string;
  providerRequest: ProviderRequest;
  providerResult: ProviderResult;
}

export interface MentionProcessingResult {
  mentionSystemPrompt: string;
  mentionedPageIds: string[];
}

export interface GetRequestPagination {
  limit: number;
  cursor: string | null;
  direction: 'before' | 'after';
}

export interface GetRequestContext {
  userId: string;
  conversationId: string;
  pagination: GetRequestPagination;
}
