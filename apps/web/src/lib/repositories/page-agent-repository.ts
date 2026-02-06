/**
 * Repository for page agent database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of routes without ORM chain mocking.
 */

import { db, pages, drives, eq, and, desc, isNull } from '@pagespace/db';
import { applyPageMutation, type PageMutationContext } from '@/services/api/page-mutation-service';

/**
 * Calculate the next position for a page based on sibling positions.
 * Pure function extracted for unit testability.
 */
export function calculateNextPosition(siblingPages: { position: number }[]): number {
  return siblingPages.length > 0 ? siblingPages[0].position + 1 : 1;
}

export interface Drive {
  id: string;
  ownerId: string;
}

export interface ParentPage {
  id: string;
}

export interface AgentData {
  title: string;
  type: 'AI_CHAT';
  content: string;
  position: number;
  driveId: string;
  parentId: string | null;
  isTrashed: boolean;
  systemPrompt?: string | null;
  enabledTools?: string[] | null;
  aiProvider?: string | null;
  aiModel?: string | null;
}

export interface CreatedAgent {
  id: string;
  title: string;
  type: string;
}

export const pageAgentRepository = {
  /**
   * Get a drive by ID
   */
  async getDriveById(driveId: string): Promise<Drive | null> {
    const [drive] = await db
      .select({ id: drives.id, ownerId: drives.ownerId })
      .from(drives)
      .where(eq(drives.id, driveId));

    return drive || null;
  },

  /**
   * Get a parent page by ID, verifying it belongs to the specified drive
   */
  async getParentPage(parentId: string, driveId: string): Promise<ParentPage | null> {
    const [parentPage] = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(
        eq(pages.id, parentId),
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false)
      ));

    return parentPage || null;
  },

  /**
   * Calculate the next position for a new page in a drive/parent
   */
  async getNextPosition(driveId: string, parentId: string | null): Promise<number> {
    const siblingPages = await db
      .select({ position: pages.position })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
        eq(pages.isTrashed, false)
      ))
      .orderBy(desc(pages.position));

    return calculateNextPosition(siblingPages);
  },

  /**
   * Create a new agent page
   */
  async createAgent(data: AgentData): Promise<CreatedAgent> {
    const [newAgent] = await db
      .insert(pages)
      .values(data)
      .returning({ id: pages.id, title: pages.title, type: pages.type });

    return newAgent;
  },

  /**
   * Get an agent by ID with full details
   */
  async getAgentById(agentId: string): Promise<AgentDetails | null> {
    const [agent] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, agentId));

    if (!agent) return null;

    // Cast enabledTools from unknown (jsonb) to string[] | null
    return {
      id: agent.id,
      title: agent.title,
      type: agent.type,
      driveId: agent.driveId,
      parentId: agent.parentId,
      systemPrompt: agent.systemPrompt,
      enabledTools: agent.enabledTools as string[] | null,
      aiProvider: agent.aiProvider,
      aiModel: agent.aiModel,
      isTrashed: agent.isTrashed,
    };
  },

  /**
   * Update an agent's configuration
   * @throws Error if agent not found (no rows updated)
   */
  async updateAgentConfig(
    agentId: string,
    data: AgentConfigUpdate,
    options: { context: PageMutationContext; expectedRevision?: number }
  ): Promise<UpdatedAgent> {
    const updates = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined)
    );
    const updatedFields = Object.keys(updates);
    if (updatedFields.length === 0) {
      throw new Error('No agent config fields provided');
    }

    await applyPageMutation({
      pageId: agentId,
      operation: 'agent_config_update',
      updates,
      updatedFields,
      expectedRevision: options.expectedRevision,
      context: {
        ...options.context,
        resourceType: options.context.resourceType ?? 'agent',
      },
    });

    const [updated] = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        driveId: pages.driveId,
      })
      .from(pages)
      .where(eq(pages.id, agentId))
      .limit(1);

    if (!updated) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return updated;
  },
};

export interface AgentDetails {
  id: string;
  title: string;
  type: string;
  driveId: string;
  parentId: string | null;
  systemPrompt: string | null;
  enabledTools: string[] | null;
  aiProvider: string | null;
  aiModel: string | null;
  isTrashed: boolean;
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
}

export interface UpdatedAgent {
  id: string;
  title: string;
  type: string;
  driveId: string;
}
