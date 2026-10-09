/**
 * Shared Agent Types
 *
 * This module provides a single source of truth for agent-related types
 * used across both dashboard (usePageAgentDashboardStore) and sidebar (usePageAgentSidebarState) contexts.
 */

/**
 * Agent information for selected agents.
 * Used in both dashboard and sidebar contexts.
 *
 * null = Global Assistant mode (no agent selected)
 */
export interface AgentInfo {
  /** Unique identifier for the agent (page ID) */
  id: string;
  /** Display title of the agent */
  title: string;
  /** Drive ID where this agent belongs */
  driveId: string;
  /** Display name of the drive */
  driveName: string;
  /** Optional system prompt for the agent */
  systemPrompt?: string;
  /** Optional AI provider override */
  aiProvider?: string;
  /** Optional AI model override */
  aiModel?: string;
  /** Optional list of enabled tools */
  enabledTools?: string[];
}

/**
 * Type guard for validating AgentInfo objects.
 * Useful for validating data from localStorage or other untrusted sources.
 */
export function isValidAgentInfo(data: unknown): data is AgentInfo {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Required fields
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return false;
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    return false;
  }
  if (typeof obj.driveId !== 'string' || obj.driveId.length === 0) {
    return false;
  }
  if (typeof obj.driveName !== 'string' || obj.driveName.length === 0) {
    return false;
  }

  // Optional fields validation (if present, must be correct type)
  if (obj.systemPrompt !== undefined && typeof obj.systemPrompt !== 'string') {
    return false;
  }
  if (obj.aiProvider !== undefined && typeof obj.aiProvider !== 'string') {
    return false;
  }
  if (obj.aiModel !== undefined && typeof obj.aiModel !== 'string') {
    return false;
  }
  if (obj.enabledTools !== undefined) {
    if (!Array.isArray(obj.enabledTools)) {
      return false;
    }
    if (!obj.enabledTools.every((tool) => typeof tool === 'string')) {
      return false;
    }
  }

  return true;
}
