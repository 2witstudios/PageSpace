import { z } from 'zod';
import { tool } from 'ai';
import { db, pages, chatMessages, eq, and, asc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';
import { getUserAccessLevel } from '@pagespace/lib';
import { ToolExecutionContext } from '../types';

/**
 * Tool for discovering AI agents (all AI_CHAT pages) in the workspace
 */
export const discover_agents = tool({
  description: `Find AI agents available in the workspace. Returns all AI_CHAT pages, which are all agents with varying levels of configuration.`,
  
  inputSchema: z.object({
    query: z.string().optional().describe('Optional search query to filter agents by relevance'),
    driveId: z.string().optional().describe('Optional drive ID to limit search to a specific workspace'),
  }),
  
  execute: async ({ query, driveId }, { experimental_context: context }) => {
    const userId = (context as ToolExecutionContext)?.userId;
    
    if (!userId) {
      return { error: 'Authentication required to discover agents' };
    }
    
    try {
      // Build query for ALL AI_CHAT pages (they're all agents)
      const conditions = [
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ];
      
      if (driveId) {
        conditions.push(eq(pages.driveId, driveId));
      }
      
      // Fetch all AI_CHAT pages
      const agents = await db.select({
        id: pages.id,
        title: pages.title,
        driveId: pages.driveId,
        parentId: pages.parentId,
      })
      .from(pages)
      .where(and(...conditions));
      
      // Filter by permissions and check for custom configuration
      const accessibleAgents = [];
      for (const agent of agents) {
        const accessLevel = await getUserAccessLevel(userId, agent.id);
        if (accessLevel?.canView) {
          // Check if agent has a custom system prompt (first message)
          const firstMessage = await db.query.chatMessages.findFirst({
            where: and(
              eq(chatMessages.pageId, agent.id),
              eq(chatMessages.role, 'system')
            ),
            orderBy: [asc(chatMessages.createdAt)]
          });
          
          accessibleAgents.push({
            id: agent.id,
            title: agent.title,
            description: firstMessage ? 'Specialized agent' : `General agent for ${agent.title}`,
            driveId: agent.driveId,
            parentId: agent.parentId,
            hasCustomPrompt: !!firstMessage,
            canEdit: accessLevel.canEdit,
            configured: !!firstMessage,
          });
        }
      }
      
      // If query provided, sort by relevance (simple text matching for now)
      if (query) {
        const queryLower = query.toLowerCase();
        accessibleAgents.sort((a, b) => {
          const aRelevance = 
            (a.title.toLowerCase().includes(queryLower) ? 2 : 0) +
            (a.description?.toLowerCase().includes(queryLower) ? 1 : 0);
          const bRelevance = 
            (b.title.toLowerCase().includes(queryLower) ? 2 : 0) +
            (b.description?.toLowerCase().includes(queryLower) ? 1 : 0);
          return bRelevance - aRelevance;
        });
      }
      
      loggers.ai.info('Agent discovery completed', { 
        userId, 
        query, 
        driveId, 
        agentCount: accessibleAgents.length 
      });
      
      return {
        agents: accessibleAgents,
        count: accessibleAgents.length,
        query,
      };
    } catch (error) {
      loggers.ai.error('Error discovering agents:', error as Error);
      return { error: 'Failed to discover agents' };
    }
  },
});

/**
 * Tool for invoking a specialized AI agent with a specific query
 */
export const invoke_agent = tool({
  description: `Consult a specialized AI agent by sending it a query. The agent will respond based on its custom system prompt and available tools.`,
  
  inputSchema: z.object({
    agentId: z.string().describe('The ID of the AI_CHAT page to invoke as an agent'),
    query: z.string().describe('The question or task for the agent'),
    context: z.record(z.unknown()).optional().describe('Optional additional context to pass to the agent'),
  }),
  
  execute: async ({ agentId, query }, { experimental_context: context }) => {
    const userId = (context as ToolExecutionContext)?.userId;
    
    if (!userId) {
      return { error: 'Authentication required to invoke agents' };
    }
    
    try {
      // Check user has access to the agent
      const accessLevel = await getUserAccessLevel(userId, agentId);
      if (!accessLevel?.canView) {
        return { error: 'Access denied to this agent' };
      }
      
      // Load the agent (all AI_CHAT pages are agents)
      const agent = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, agentId),
          eq(pages.type, 'AI_CHAT'),
          eq(pages.isTrashed, false)
        ),
      });
      
      if (!agent) {
        return { error: 'Agent not found' };
      }
      
      // Check for custom system prompt (first message)
      const firstMessage = await db.query.chatMessages.findFirst({
        where: and(
          eq(chatMessages.pageId, agentId),
          eq(chatMessages.role, 'system')
        ),
        orderBy: [asc(chatMessages.createdAt)]
      });
      
      const customPrompt = firstMessage?.content;
      
      // TODO: In a real implementation, this would create a temporary chat session
      // with the agent and stream the response. For now, we'll return the configuration
      // and indicate that the agent has been prepared for invocation.
      
      loggers.ai.info('Agent invoked', { 
        userId, 
        agentId, 
        agentTitle: agent.title,
        query 
      });
      
      return {
        agentId: agent.id,
        agentTitle: agent.title,
        agentDescription: customPrompt ? 'Specialized agent' : `General agent for ${agent.title}`,
        status: 'ready',
        message: customPrompt 
          ? `Agent "${agent.title}" is ready with its specialized configuration.`
          : `Agent "${agent.title}" is ready as a general-purpose assistant for this location.`,
        invocationContext: {
          query,
          hasCustomPrompt: !!customPrompt,
        },
        // In a real implementation, this would include the actual response from the agent
        // For now, we indicate that the invocation is prepared
        note: 'Full agent invocation will be implemented with streaming chat session support',
      };
    } catch (error) {
      loggers.ai.error('Error invoking agent:', error as Error);
      return { error: 'Failed to invoke agent' };
    }
  },
});

// Export the agent tools
export const agentTools = {
  discover_agents,
  invoke_agent,
};