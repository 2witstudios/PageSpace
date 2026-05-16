/**
 * Shared types for the Global Prompt Admin Page
 *
 * Used by:
 * - /api/admin/global-prompt/route.ts
 * - /admin/global-prompt/page.tsx
 * - /admin/global-prompt/GlobalPromptClient.tsx
 */

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  optional?: boolean;
}

export interface JsonSchema {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  description?: string;
}

export interface ToolSchemaInfo {
  name: string;
  description: string;
  parameters: JsonSchema;
  tokenEstimate: number;
}

export interface PromptSection {
  name: string;
  content: string;
  source: string;
  lines?: string;
  tokens: number;
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
    locationContext?: {
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
      breadcrumbs?: Array<{ id: string; title: string }>;
    };
    modelCapabilities: {
      hasVision: boolean;
      hasTools: boolean;
      model: string;
      provider: string;
    };
    chatSource: {
      type: 'page';
      agentPageId: string;
      agentTitle: string;
    };
    enabledTools: string[] | null;
  };
}

export interface TokenEstimates {
  systemPrompt: number;
  tools: number;
  experimentalContext: number;
  total: number;
}

export interface CompletePayloadResult {
  request: CompleteAIRequest;
  formattedString: string;
  tokenEstimates: TokenEstimates;
  nonCoreToolNames: string[];
}

export interface RolePromptData {
  mode: 'fullAccess' | 'readOnly';
  fullPrompt: string;
  sections: PromptSection[];
  totalTokens: number;
  toolsAllowed: string[];
  toolsDenied: string[];
  nonCoreToolNames: string[];
  permissions: {
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
    canOrganize: boolean;
  };
  // Complete payload for this mode (exact LLM request)
  completePayload?: CompletePayloadResult;
}

export interface DriveInfo {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface PageInfo {
  id: string;
  title: string;
  type: string;
  path: string;
  parentId: string | null;
}

export interface ExperimentalContext {
  userId: string;
  timezone: string | undefined;
  aiProvider: string;
  aiModel: string;
  conversationId: string;
  modelCapabilities: {
    hasVision: boolean;
    hasTools: boolean;
    model: string;
    provider: string;
  };
  locationContext: {
    currentDrive?: {
      id: string;
      name: string;
      slug: string;
    };
    currentPage?: {
      id: string;
      title: string;
      type: string;
      path: string;
    };
    breadcrumbs?: Array<{ id: string; title: string }>;
  } | null;
  chatSource: {
    type: 'page';
    agentPageId: string;
    agentTitle: string;
  };
  enabledTools: string[] | null;
}

export interface GlobalPromptResponse {
  promptData: Record<string, RolePromptData>;
  toolSchemas?: ToolSchemaInfo[];
  totalToolTokens?: number;
  experimentalContext?: ExperimentalContext;
  availableDrives?: DriveInfo[];
  availablePages?: PageInfo[];
  nonCoreToolNames?: string[];
  metadata: {
    generatedAt: string;
    adminUser: {
      id: string;
      role: 'user' | 'admin';
    };
    locationContext?: {
      currentDrive?: {
        id: string;
        name: string;
        slug: string;
      };
      currentPage?: {
        id: string;
        title: string;
        type: string;
        path: string;
      };
      breadcrumbs?: Array<{ id: string; title: string }>;
    };
    selectedDriveId: string | null;
    selectedPageId: string | null;
    contextType?: 'dashboard' | 'drive' | 'page';
  };
}
