/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These types are shared across AI tools.
 */

import { ModelCapabilities } from './model-capabilities';

export interface ToolExecutionContext {
  userId: string;
  conversationId?: string;
  // User's IANA timezone (e.g., "America/New_York") for timezone-aware tool operations
  timezone?: string;
  // AI attribution for activity logging
  aiProvider?: string;
  aiModel?: string;
  locationContext?: {
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
    breadcrumbs?: string[];
  };
  modelCapabilities?: ModelCapabilities;

  // Agent chain tracking (Tier 1) - for tracking changes made by sub-agents
  parentAgentId?: string;           // Agent that called this agent via ask_agent
  parentConversationId?: string;    // Parent's conversation ID for linking
  agentChain?: string[];            // Full chain: [rootAgentId, ...intermediates, currentAgentId]
  requestOrigin?: 'user' | 'agent'; // Whether request came from user or another agent
  agentCallDepth?: number;          // Depth of agent call chain (0 = direct user request)
}