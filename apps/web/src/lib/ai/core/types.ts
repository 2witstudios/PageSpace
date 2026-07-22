/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These types are shared across AI tools.
 */

import { ModelCapabilities } from './model-capabilities';
import type { CommandExecutionData } from './command-processor';
import type { MachineRef } from '@/lib/repositories/page-agent-repository';
import type { MachineNodeHandleSet } from '@pagespace/lib/services/machines/machine-pane-binding';

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

  // The page the agent is currently focused on for THIS turn: seeded from the
  // request's location/page context, then mutated in place by tools that
  // represent the agent switching focus (e.g. create_page) — same
  // mutate-in-place pattern as activeMachine above, so later page tool calls
  // in the same turn default to wherever the agent's own actions left it,
  // not just the page the user was on when the turn started. Used by
  // resolveDefaultPageId (page-context-defaults.ts) to default an omitted
  // `pageId` argument on read/write page tools.
  currentWorkingPage?: { id: string; title: string; type: string };

  // Sprites Platform Alignment 5-2: a stable id for THIS agent turn (one
  // streamText run), lazily stamped once by `resolveSandboxActorContext`
  // (apps/web/src/lib/ai/tools/sandbox-tools-runtime.ts) the first time a
  // sandbox tool call reads this context, then reused by every later bash
  // call in the same run — same mutate-in-place pattern as `activeMachine`
  // above. Threads into `SandboxActorContext.turnId`, which gates the
  // pre-batch checkpoint's "at most once per turn" throttle
  // (`checkpoint-policy.ts`). Undefined until first stamped.
  turnId?: string;

  // "PageSpace Agent" panes (Terminal epics, issue #2166): the server-derived
  // HANDLE SET that pins THIS run's default-mode code-exec tools (bash/
  // readFile/writeFile/editFile/git) to the machine node the pane is bound to
  // AND to every node beneath it — `self` is the pane's own node (its cwd and,
  // for a branch, its Sprite); `handles` is the downward closure a `target`
  // argument may address. Computed once per request from
  // `deriveMachinePaneBinding` (@pagespace/lib/services/machines/
  // machine-pane-binding) and never mutated in place afterward (unlike
  // `activeMachine`, a pagespace pane's binding is fixed for the
  // conversation's lifetime, not switchable mid-turn). Undefined for every
  // conversation that isn't a machine-bound pagespace pane.
  //
  // This set is the ONLY authorization fact for the machine tool surface:
  // `isMachineAccessible` (sandbox-tools-runtime.ts) exempts a machine because
  // it is in this set, and `open()`'s target resolution addresses a node
  // because it is in this set. Nothing else may decide node access.
  machineBinding?: MachineNodeHandleSet;
}