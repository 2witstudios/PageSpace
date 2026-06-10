/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These types are shared across AI tools.
 */

import { ModelCapabilities } from './model-capabilities';
import type { CommandExecutionData } from './command-processor';

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

  // Allowlist of tool names this agent is permitted to execute (null = unrestricted)
  enabledTools?: string[] | null;

  // MCP token drive-scope restriction. Empty/undefined = full access (session auth
  // or an unscoped MCP token); non-empty = tools may only touch these drive IDs.
  // Enforced in actor-permissions so a scoped token cannot escalate through an
  // agent whose own ACL spans drives outside the token scope.
  mcpAllowedDriveIds?: string[];

  // Chat source identification - determines sender identity for channel messages
  chatSource?: {
    type: 'global' | 'page';
    agentPageId?: string;   // For page agents: the AI_CHAT page ID
    agentTitle?: string;    // For page agents: the agent display name
  };

  // Universal Commands execution feedback for the message this context posts
  // (channel agent replies): carried into the reply's aiMeta so the channel
  // renders the "Using /foo" / "Skipped /foo" indicator (UX spec §7).
  commandExecution?: CommandExecutionData;
}