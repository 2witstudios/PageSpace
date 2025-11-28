/**
 * System Prompt Builder for PageSpace AI
 *
 * Single unified prompt with optional read-only mode.
 * Replaces the complex 3-role system with simple, trust-the-model approach.
 */

export interface ContextInfo {
  driveName?: string;
  driveSlug?: string;
  driveId?: string;
  pagePath?: string;
  pageType?: string;
  breadcrumbs?: string[];
}

const CORE_PROMPT = `You are PageSpace AI. You can explore, read, and modify the user's workspace. Balance conversation with action based on what the user needs.`;

const BEHAVIOR_PROMPT = `APPROACH:
• When ideas are forming, engage in conversation before reaching for tools
• When intent is clear (find, create, show me), use tools right away
• Share interesting findings as you work
• Complete what you start, don't overextend beyond what was asked

STYLE:
• Skip preambles ("I'll help you...") and postambles ("Let me know if...")
• Skip flattery ("Great question!"). Respond directly.
• Be concise but conversational - like a knowledgeable colleague
• Match user energy - conversational when exploring, efficient when executing`;

const READ_ONLY_CONSTRAINT = `READ-ONLY MODE:
• You cannot modify, create, or delete any content
• Focus on exploring, analyzing, and planning
• Create actionable plans for the user to execute later`;

/**
 * Build context-specific prompt section
 */
function buildContextPrompt(
  contextType: 'dashboard' | 'drive' | 'page',
  contextInfo?: ContextInfo
): string {
  if (!contextInfo) {
    return `CONTEXT: Operating in ${contextType} mode.`;
  }

  switch (contextType) {
    case 'dashboard':
      return `DASHBOARD CONTEXT:
• Operating across all workspaces
• Focus on cross-workspace tasks and personal productivity`;

    case 'drive':
      return `DRIVE CONTEXT:
• Current Workspace: "${contextInfo.driveName}" (Slug: ${contextInfo.driveSlug}, ID: ${contextInfo.driveId})
• When users say "here" or "this workspace", they mean: ${contextInfo.driveSlug}`;

    case 'page':
      return `PAGE CONTEXT:
• Location: ${contextInfo.pagePath}
• Type: ${contextInfo.pageType}
• Path: ${contextInfo.breadcrumbs?.join(' > ')}
• When users say "here", they mean this page`;

    default:
      return `CONTEXT: ${contextType} mode`;
  }
}

/**
 * Build a complete system prompt
 */
export function buildSystemPrompt(
  contextType: 'dashboard' | 'drive' | 'page',
  contextInfo?: ContextInfo,
  isReadOnly: boolean = false
): string {
  const contextPrompt = buildContextPrompt(contextType, contextInfo);

  const sections = [
    '# PAGESPACE AI',
    isReadOnly
      ? CORE_PROMPT.replace(
          'modify',
          'explore (read-only mode - no modifications)'
        )
      : CORE_PROMPT,
    contextPrompt,
    BEHAVIOR_PROMPT,
    isReadOnly ? READ_ONLY_CONSTRAINT : null,
  ].filter(Boolean);

  return sections.join('\n\n');
}

/**
 * Get welcome message
 */
export function getWelcomeMessage(
  isReadOnly: boolean,
  isNew: boolean = false
): string {
  const prefix = isNew ? 'Welcome! ' : '';

  if (isReadOnly) {
    return `${prefix}I'm in read-only mode. I can explore and analyze but won't make changes. What would you like to understand?`;
  }

  return `${prefix}I can help explore, understand, and work on your content. What would you like to work on?`;
}

/**
 * Get error message
 */
export function getErrorMessage(error: string): string {
  return `Issue: ${error}. Would you like me to try a different approach?`;
}

/**
 * Estimate token count for system prompt
 * Rough estimate: 4 characters per token
 */
export function estimateSystemPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
