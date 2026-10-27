/**
 * Agent Repository - Clean seam for AI agent operations
 *
 * AI Agents are stored as pages with type='AI_CHAT'.
 * This repository provides a semantic interface for agent-specific operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { assertNoContentWrite } from './page-write-guard';

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
  /**
   * The per-agent sandbox switch. Read here because an agent's stored tool
   * allowlist cannot be described honestly without it: while this is false the
   * whole sandbox family is stripped whatever `enabledTools` says (issue #2460).
   */
  sandboxEnabled: boolean;
  toolExposureMode: 'upfront' | 'search';
  userScopedAccess: boolean;
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
  userScopedAccess?: boolean;
  updatedAt?: Date;
}

export const agentRepository = {
  /**
   * Find an AI agent by ID
   */
  findById: async (agentId: string): Promise<AgentRecord | null> => {
    const [agent] = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        driveId: pages.driveId,
        systemPrompt: pages.systemPrompt,
        enabledTools: pages.enabledTools,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        agentDefinition: pages.agentDefinition,
        visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
        includeDrivePrompt: pages.includeDrivePrompt,
        includePageTree: pages.includePageTree,
        pageTreeScope: pages.pageTreeScope,
        sandboxEnabled: pages.sandboxEnabled,
        toolExposureMode: pages.toolExposureMode,
        userScopedAccess: pages.userScopedAccess,
        revision: pages.revision,
        stateHash: pages.stateHash,
      })
      .from(pages)
      .where(and(
        eq(pages.id, agentId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ))
      .limit(1);

    if (!agent) {
      return null;
    }

    return {
      ...agent,
      enabledTools: agent.enabledTools as string[] | null,
      visibleToGlobalAssistant: agent.visibleToGlobalAssistant ?? true,
      includeDrivePrompt: agent.includeDrivePrompt ?? false,
      includePageTree: agent.includePageTree ?? false,
      sandboxEnabled: agent.sandboxEnabled ?? false,
      toolExposureMode: agent.toolExposureMode ?? 'upfront',
      userScopedAccess: agent.userScopedAccess ?? false,
    };
  },

  /**
   * Update an agent's configuration
   */
  updateConfig: async (
    agentId: string,
    config: AgentConfigUpdate
  ): Promise<void> => {
    assertNoContentWrite(config, 'agentRepository.updateConfig');

    const updateData: Record<string, unknown> = {
      ...config,
      updatedAt: config.updatedAt ?? new Date(),
    };

    await db.update(pages).set(updateData).where(eq(pages.id, agentId));
  },
};

export type AgentRepository = typeof agentRepository;
