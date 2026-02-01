/**
 * Pure Tool Validation Function
 *
 * Checks if a tool is allowed given all permission layers:
 * 1. Tool exists in provider's tools
 * 2. Tool is in grant's allowedTools (or allowedTools is null)
 * 3. Tool is not in grant's deniedTools
 * 4. If readOnly, tool must be category 'read'
 * 5. Dangerous tools require explicit allowedTools entry
 *
 * This is a PURE function - no side effects, deterministic output.
 */

import type { ToolAllowedResult, ToolAllowedConfig } from '../types';

/**
 * Check if a tool is allowed based on provider and grant configuration.
 *
 * @param toolName - The ID of the tool to check
 * @param config - Permission configuration from provider and grant
 * @returns Whether the tool is allowed and reason if not
 */
export const isToolAllowed = (
  toolName: string,
  config: ToolAllowedConfig
): ToolAllowedResult => {
  const { providerTools, grantAllowedTools, grantDeniedTools, grantReadOnly } = config;

  // 1. Check if tool exists in provider's tool list
  const tool = providerTools.find((t) => t.id === toolName);
  if (!tool) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' not found in provider's tool list`,
    };
  }

  // 2. Check if tool is in denied list (deny takes precedence)
  if (grantDeniedTools?.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is explicitly denied`,
    };
  }

  // 3. Check readOnly restriction
  if (grantReadOnly && tool.category !== 'read') {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not allowed in read-only mode (category: ${tool.category})`,
    };
  }

  // 4. Check dangerous tools require explicit entry
  if (tool.category === 'dangerous') {
    if (grantAllowedTools === null || !grantAllowedTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' with category 'dangerous' requires explicit allowedTools entry`,
      };
    }
  }

  // 5. Check if tool is in allowed list (when list is specified)
  if (grantAllowedTools !== null && !grantAllowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not in allowed list`,
    };
  }

  // All checks passed
  return { allowed: true };
};
