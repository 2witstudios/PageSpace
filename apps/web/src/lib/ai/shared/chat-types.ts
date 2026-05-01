/**
 * Shared types for AI chat views (GlobalAssistantView, AiChatView)
 * These types are used across multiple chat components.
 */

/**
 * Provider availability snapshot returned by /api/ai/chat and /api/ai/settings.
 * Each entry tells the UI whether the deployment can route AI calls through that
 * provider (managed env keys present + on-prem allowlist satisfied).
 */
export interface ProviderAvailability {
  isAvailable: boolean;
}

export interface ProviderSettings {
  currentProvider: string;
  currentModel: string;
  providers: Partial<Record<
    | 'pagespace'
    | 'openrouter'
    | 'openrouter_free'
    | 'google'
    | 'openai'
    | 'anthropic'
    | 'xai'
    | 'ollama'
    | 'lmstudio'
    | 'glm'
    | 'minimax'
    | 'azure_openai',
    ProviderAvailability
  >>;
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
    isTaskLinked?: boolean;
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
