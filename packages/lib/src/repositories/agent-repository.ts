/**
 * Agent Repository - Clean seam for AI agent operations
 *
 * AI Agents are stored as pages with type='AI_CHAT'.
 * This repository provides a semantic interface for agent-specific operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db, pages, eq, and } from '@pagespace/db';

// Types for repository operations
export interface AgentRecord {
  id: string;
  title: string;
  type: string;
  driveId: string;
  systemPrompt: string | null;
  enabledTools: string[] | null;
  aiProvider: string | null;
  aiModel: string | null;
  agentDefinition: string | null;
  visibleToGlobalAssistant: boolean;
  includeDrivePrompt: boolean;
  includePageTree: boolean;
  pageTreeScope: 'children' | 'drive' | null;
  revision: number;
  stateHash?: string | null;
}

export interface AgentConfigUpdate {
  systemPrompt?: string | null;
  enabledTools?: string[] | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  agentDefinition?: string | null;
  visibleToGlobalAssistant?: boolean;
  includeDrivePrompt?: boolean;
  includePageTree?: boolean;
  pageTreeScope?: 'children' | 'drive';
  updatedAt?: Date;
}

export const agentRepository = {
  /**
   * Find an AI agent by ID
   */
  findById: async (agentId: string): Promise<AgentRecord | null> => {
    const agent = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, agentId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ),
    });

    return agent as AgentRecord | null;
  },

  /**
   * Update an agent's configuration
   */
  updateConfig: async (
    agentId: string,
    config: AgentConfigUpdate
  ): Promise<void> => {
    const updateData: Record<string, unknown> = {
      ...config,
      updatedAt: config.updatedAt ?? new Date(),
    };

    await db.update(pages).set(updateData).where(eq(pages.id, agentId));
  },
};

export type AgentRepository = typeof agentRepository;
