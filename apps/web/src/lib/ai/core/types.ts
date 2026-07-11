/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These types are shared across AI tools.
 */

import { ModelCapabilities } from './model-capabilities';
import type { CommandExecutionData } from './command-processor';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';

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

  // Image generation: whether the caller is an app admin (the rollout gate), the
  // user's subscription tier (for the billing gate), and their chosen OpenRouter
  // image model. Threaded by the chat/global routes so the generate_image tool can
  // gate + pick a model without an extra DB read.
  isAdmin?: boolean;
  subscriptionTier?: string;
  imageGenerationModel?: string | null;

  // MCP token drive-scope restriction. Empty/undefined = full access (session auth
  // or an unscoped MCP token); non-empty = tools may only touch these drive IDs.
  // Enforced in actor-permissions so a scoped token cannot escalate through an
  // agent whose own ACL spans drives outside the token scope.
  mcpAllowedDriveIds?: string[];

  // The MCP token id, set alongside mcpAllowedDriveIds. For scoped tokens this
  // enables the app-member RBAC ceiling in actor-permissions: the token's own
  // drive-membership role caps what tools may do, on top of the drive scope.
  mcpTokenId?: string;

  // Chat source identification - determines sender identity for channel messages
  chatSource?: {
    type: 'global' | 'page';
    agentPageId?: string;   // For page agents: the AI_CHAT page ID
    agentTitle?: string;    // For page agents: the agent display name
  };

  // Universal Commands execution feedback for the message this context posts
  // (channel agent replies): carried into the reply's aiMeta so the channel
  // renders one "Using /foo" / "Skipped /foo" indicator per resolved command
  // (UX spec §7), in document order.
  commandExecution?: CommandExecutionData[];

  // Terminal epics: the ACTIVE machine for this run's terminal tool group
  // (bash/readFile/writeFile/editFile/git + switch_machine/list_machines).
  // This context object is the SAME reference for every tool call within one
  // streamText run (AI SDK threads it unchanged through the step loop), so
  // switch_machine mutates this field in place and later tool calls in the
  // same turn see the new active machine. Undefined means "not yet
  // switched" — callers fall back to the configured machines[0].
  activeMachine?: MachineRef;
}