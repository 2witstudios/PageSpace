/**
 * Shared types for AI chat views (GlobalAssistantView, AiChatView)
 * These types are used across multiple chat components.
 */

/**
 * Provider configuration status from the backend
 */
export interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: {
    pagespace?: { isConfigured: boolean; hasApiKey: boolean };
    openrouter: { isConfigured: boolean; hasApiKey: boolean };
    google: { isConfigured: boolean; hasApiKey: boolean };
    openai?: { isConfigured: boolean; hasApiKey: boolean };
    anthropic?: { isConfigured: boolean; hasApiKey: boolean };
    xai?: { isConfigured: boolean; hasApiKey: boolean };
    ollama?: { isConfigured: boolean; hasBaseUrl: boolean };
    glm?: { isConfigured: boolean; hasApiKey: boolean };
  };
  isAnyProviderConfigured: boolean;
}

/**
 * MCP tool schema from Electron bridge
 */
export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  serverName: string;
}

/**
 * Conversation data from the API
 */
export interface ConversationData {
  id: string;
  title: string;
  preview: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastMessage: {
    role: string;
    timestamp: Date;
  };
}

/**
 * Raw conversation data from API (before date parsing)
 */
export interface RawConversationData {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: {
    role: string;
    timestamp: string;
  };
}

/**
 * Location context for global assistant
 */
export interface LocationContext {
  currentPage?: {
    id: string;
    title: string;
    type: string;
    path: string;
  } | null;
  currentDrive?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  breadcrumbs?: string[];
}

/**
 * Agent configuration from the backend
 */
export interface AgentConfig {
  systemPrompt: string;
  enabledTools: string[];
  availableTools: Array<{ name: string; description: string }>;
  aiProvider?: string;
  aiModel?: string;
}

/**
 * Transform raw conversation data with proper date parsing
 */
export function parseConversationData(raw: RawConversationData): ConversationData {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    lastMessage: {
      ...raw.lastMessage,
      timestamp: new Date(raw.lastMessage.timestamp),
    },
  };
}

/**
 * Transform array of raw conversation data
 */
export function parseConversationsData(rawList: RawConversationData[]): ConversationData[] {
  return rawList.map(parseConversationData);
}
