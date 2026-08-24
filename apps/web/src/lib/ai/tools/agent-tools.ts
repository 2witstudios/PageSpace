import { tool } from 'ai';
import { z } from 'zod';
import { canActorEditPage, isMcpScoped } from './actor-permissions';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { agentRepository } from '@pagespace/lib/repositories/agent-repository';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { maskIdentifier } from '@/lib/logging/mask';
import type { ToolExecutionContext } from '../core/types';
import { pageSpaceTools } from '../core/ai-tools';
import { filterToolsForMcpScope } from '../core/tool-filtering';
import {
  describeAgentToolSurface,
  formatAgentToolSurfaceNotes,
} from '../core/agent-tool-surface';
import { validateAgentModelSelection } from '../core/ai-providers-config';
import { applyPageMutation } from '@/services/api/page-mutation-service';

const agentLogger = loggers.ai.child({ module: 'agent-tools' });

export const agentTools = {
  /**
   * Update an existing AI agent's configuration
   */
  update_agent_config: tool({
    description: 'Update the configuration of an existing AI agent, including system prompt, enabled tools, AI provider, and model settings. Does not manage triggers — use set_calendar_trigger, set_task_trigger, or create_workflow for scheduling.',
    inputSchema: z.object({
      agentPath: z.string().describe('The agent path using titles like "/driveSlug/Agent Name" for semantic context'),
      agentId: z.string().describe('The unique ID of the AI agent to update'),
      systemPrompt: z.string().optional().describe('New system prompt for the agent. Leave empty to keep current prompt.'),
      enabledTools: z.array(z.string()).optional().describe('New array of enabled tool names. Leave empty to keep current tools.'),
      aiProvider: z.string().optional().describe('New AI provider for the agent'),
      aiModel: z.string().optional().describe('New AI model for the agent'),
      agentDefinition: z.string().max(500).optional().describe('New description of what this agent does (max 500 chars).'),
      visibleToGlobalAssistant: z.boolean().optional().describe('Whether this agent appears in the global assistant\'s available agents list.'),
      includeDrivePrompt: z.boolean().optional().describe('Include drive-level AI instructions in the agent\'s context.'),
      includePageTree: z.boolean().optional().describe('Include page tree structure in the agent\'s context.'),
      pageTreeScope: z.enum(['children', 'drive']).optional().describe('Scope for page tree: "children" or "drive".'),
      sandboxEnabled: z.boolean().optional().describe('Whether this agent is offered the sandbox tool families (bash/writeFile/readFile/editFile, the git+gh toolkit, and the session/shell tools). Off by default: while it is off, naming those tools in enabledTools grants NOTHING — the switch strips them whatever the allowlist says.'),
      toolExposureMode: z.enum(['upfront', 'search']).optional().describe('How tools are exposed to the agent: "upfront" sends every enabled tool schema directly, "search" sends only core tools plus tool_search/execute_tool so the model discovers the rest on demand.'),
      userScopedAccess: z.boolean().optional().describe('Owner-only: when true, this agent falls back to the invoking user\'s own access instead of being confined to its own drive memberships. Use for personal/global-style assistants that need the user\'s full reach.'),
    }),
    execute: async ({ agentPath, agentId, systemPrompt, enabledTools, aiProvider, aiModel, agentDefinition, visibleToGlobalAssistant, includeDrivePrompt, includePageTree, pageTreeScope, sandboxEnabled, toolExposureMode, userScopedAccess }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get the agent page via repository seam
        const agent = await agentRepository.findById(agentId);

        if (!agent) {
          throw new Error(`AI agent with ID "${agentId}" not found`);
        }

        // Check permissions
        const canEdit = await canActorEditPage(context as ToolExecutionContext, agent.id);
        if (!canEdit) {
          throw new Error('Insufficient permissions to update this AI agent');
        }

        // userScopedAccess widens the agent's reach to the invoking user's entire
        // account, so it's gated stricter than general edit access — only the
        // drive owner may toggle it, mirroring the issue's "owner-only" flag.
        if (userScopedAccess !== undefined) {
          const driveAccess = await checkDriveAccess(agent.driveId, userId);
          if (!driveAccess.isOwner) {
            throw new Error('Only the drive owner can change this agent\'s user-scoped access setting');
          }
        }

        // Validate enabled tools if provided. A drive-scoped MCP token cannot
        // newly enable an account-level-only tool (e.g. create_drive) —
        // mirrors the runtime chat/consult tool-list filtering.
        if (enabledTools && enabledTools.length > 0) {
          const availableToolNames = Object.keys(filterToolsForMcpScope(pageSpaceTools, isMcpScoped(context as ToolExecutionContext)));
          const invalidTools = enabledTools.filter(toolName => !availableToolNames.includes(toolName));
          if (invalidTools.length > 0) {
            throw new Error(`Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}`);
          }
        }

        // Validate the model selection against the real catalog so a hallucinated
        // model id can't be stored. Fall back to the agent's stored provider/model
        // so a bad aiModel is caught even when aiProvider isn't sent.
        if (aiProvider !== undefined || aiModel !== undefined) {
          const reason = validateAgentModelSelection(
            aiProvider ?? agent.aiProvider,
            aiModel ?? agent.aiModel,
          );
          if (reason) {
            throw new Error(`${reason} Call list_models to see valid providers and models.`);
          }
        }

        // Build update data with proper typing
        interface AgentUpdateData {
          systemPrompt?: string | null;
          enabledTools?: string[] | null;
          aiProvider?: string | null;
          aiModel?: string | null;
          agentDefinition?: string | null;
          visibleToGlobalAssistant?: boolean;
          includeDrivePrompt?: boolean;
          includePageTree?: boolean;
          pageTreeScope?: 'children' | 'drive';
          sandboxEnabled?: boolean;
          toolExposureMode?: 'upfront' | 'search';
          userScopedAccess?: boolean;
        }

        const updateData: AgentUpdateData = {};

        if (systemPrompt !== undefined) {
          updateData.systemPrompt = systemPrompt || null;
        }
        if (enabledTools !== undefined) {
          updateData.enabledTools = enabledTools.length > 0 ? enabledTools : null;
        }
        if (aiProvider !== undefined) {
          updateData.aiProvider = aiProvider || null;
        }
        if (aiModel !== undefined) {
          updateData.aiModel = aiModel || null;
        }
        if (agentDefinition !== undefined) {
          updateData.agentDefinition = agentDefinition || null;
        }
        if (visibleToGlobalAssistant !== undefined) {
          updateData.visibleToGlobalAssistant = visibleToGlobalAssistant;
        }
        if (includeDrivePrompt !== undefined) {
          updateData.includeDrivePrompt = includeDrivePrompt;
        }
        if (includePageTree !== undefined) {
          updateData.includePageTree = includePageTree;
        }
        if (pageTreeScope !== undefined) {
          updateData.pageTreeScope = pageTreeScope;
        }
        if (sandboxEnabled !== undefined) {
          // Gated on plain edit access, exactly as the settings UI's
          // `PATCH /api/pages/[pageId]/agent-config` gates it — this tool is a
          // second door onto the same field, not a second policy. It used to be
          // the ONE agent field the UI could write and tools could not, which is
          // how an agent configured entirely through tools could hold a sandbox
          // allowlist it would never be granted (issue #2460).
          updateData.sandboxEnabled = sandboxEnabled;
        }
        if (toolExposureMode !== undefined) {
          updateData.toolExposureMode = toolExposureMode;
        }
        if (userScopedAccess !== undefined) {
          updateData.userScopedAccess = userScopedAccess;
        }

        const updatedFields = Object.keys(updateData);
        if (updatedFields.length === 0) {
          throw new Error('No valid fields provided for update');
        }

        const updatePayload: Record<string, unknown> = { ...updateData };
        const ctx = context as ToolExecutionContext;
        // Build chain metadata (Tier 1)
        const chainMetadata = {
          ...(ctx?.parentAgentId && { parentAgentId: ctx.parentAgentId }),
          ...(ctx?.parentConversationId && { parentConversationId: ctx.parentConversationId }),
          ...(ctx?.agentChain?.length && { agentChain: ctx.agentChain }),
          ...(ctx?.requestOrigin && { requestOrigin: ctx.requestOrigin }),
        };

        // Update the agent configuration with deterministic logging
        const actorInfo = await getActorInfo(userId);
        await applyPageMutation({
          pageId: agent.id,
          operation: 'agent_config_update',
          updates: updatePayload,
          updatedFields,
          expectedRevision: typeof agent.revision === 'number' ? agent.revision : undefined,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            isAiGenerated: true,
            aiProvider: ctx?.aiProvider,
            aiModel: ctx?.aiModel,
            aiConversationId: ctx?.conversationId,
            metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
            resourceType: 'agent',
          },
        });

        const refreshedAgent = await agentRepository.findById(agent.id);
        if (!refreshedAgent) {
          throw new Error(`Agent "${agent.title}" was deleted during the update operation`);
        }
        // refreshedAgent already contains the persisted updates from applyPageMutation
        const updatedAgent = refreshedAgent;
        const enabledToolsList = updatedAgent.enabledTools ?? [];

        // What the STORED config becomes at runtime. Echoing `enabledTools`
        // alone is what let a 24-tool sandbox config be "confirmed" on every
        // write while the worker ran with page tools only (issue #2460): the
        // sandbox switch, tool registration and the exposure mode all sit
        // between the allowlist and the model, and none of them was visible
        // from this response.
        const surface = describeAgentToolSurface({
          enabledTools: updatedAgent.enabledTools ?? null,
          sandboxEnabled: Boolean(updatedAgent.sandboxEnabled),
          toolExposureMode: updatedAgent.toolExposureMode === 'search' ? 'search' : 'upfront',
          registeredToolNames: Object.keys(
            filterToolsForMcpScope(pageSpaceTools, isMcpScoped(context as ToolExecutionContext)),
          ),
        });
        const surfaceNotes = formatAgentToolSurfaceNotes(surface);

        // Broadcast update event
        await broadcastPageEvent(
          createPageEventPayload(updatedAgent.driveId, updatedAgent.id, 'updated', {
            title: updatedAgent.title
          })
        );

        return {
          success: true,
          path: agentPath,
          id: updatedAgent.id,
          title: updatedAgent.title,
          message: surface.blocked.length > 0
            ? `Updated AI agent "${updatedAgent.title}" configuration, but ${surface.blocked.length} configured tool(s) will NOT be granted at runtime.`
            : `Successfully updated AI agent "${updatedAgent.title}" configuration`,
          summary: `Updated agent configuration${systemPrompt ? ' with new system prompt' : ''}${enabledTools ? ` and ${enabledTools.length} tools (${surface.granted.length} of them actually granted)` : ''}`,
          updatedFields,
          agentConfig: {
            hasSystemPrompt: Boolean(updatedAgent.systemPrompt),
            enabledToolsCount: enabledToolsList.length,
            enabledTools: enabledToolsList,
            // STORED vs EFFECTIVE, always both and always distinguished — the
            // divergence between them is the thing this response exists to
            // make visible.
            effectiveTools: surface.granted,
            effectiveToolsCount: surface.granted.length,
            blockedTools: surface.blocked,
            toolsNeedingComposerToggle: surface.conditional,
            toolsReachedBySearch: surface.deferred,
            sandboxEnabled: Boolean(updatedAgent.sandboxEnabled),
            toolExposureMode: updatedAgent.toolExposureMode === 'search' ? 'search' : 'upfront',
            aiProvider: updatedAgent.aiProvider ?? null,
            aiModel: updatedAgent.aiModel ?? null,
          },
          ...(surfaceNotes.length > 0 ? { warnings: surfaceNotes } : {}),
          nextSteps: [
            ...(surface.blocked.length > 0
              ? ['Resolve the warnings above — the stored config and the runtime tool surface do not agree.']
              : []),
            'Test the agent to ensure the new configuration works as expected',
            'The changes will take effect immediately in new conversations'
          ]
        };
      } catch (error) {
        agentLogger.error('Failed to update AI agent configuration', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          agentId: maskIdentifier(agentId),
          agentPath,
        });
        throw new Error(`Failed to update agent configuration at ${agentPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
