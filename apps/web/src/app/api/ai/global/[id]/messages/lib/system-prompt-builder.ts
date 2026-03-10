import { loggers } from '@pagespace/lib/server';
import {
  buildSystemPrompt,
  buildTimestampSystemPrompt,
  buildAgentAwarenessPrompt,
  getPageTreeContext,
  getDriveListSummary,
  getUserPersonalization,
  getUserTimezone,
} from '@/lib/ai/core';
import type { LocationContext, ValidatedContext } from './types';

export async function buildGlobalAssistantSystemPrompt(
  params: {
    userId: string;
    conversation: ValidatedContext['conversation'];
    locationContext?: LocationContext;
    mentionSystemPrompt: string;
    readOnlyMode: boolean;
    showPageTree: boolean;
  }
): Promise<{ finalSystemPrompt: string; userTimezone: string }> {
  const { userId, conversation, locationContext, mentionSystemPrompt, readOnlyMode, showPageTree } = params;

  const [personalization, userTimezone] = await Promise.all([
    getUserPersonalization(userId),
    getUserTimezone(userId),
  ]);

  if (personalization) {
    loggers.api.debug('Global Assistant: User personalization loaded', {
      hasPersonalization: true,
      hasBio: !!personalization.bio,
      hasWritingStyle: !!personalization.writingStyle,
      hasRules: !!personalization.rules,
    });
  }

  const contextType = locationContext?.currentPage ? 'page' :
    locationContext?.currentDrive ? 'drive' :
      'dashboard';

  const baseSystemPrompt = buildSystemPrompt(
    contextType,
    locationContext ? {
      driveName: locationContext.currentDrive?.name,
      driveSlug: locationContext.currentDrive?.slug,
      driveId: locationContext.currentDrive?.id,
      pagePath: locationContext.currentPage?.path,
      pageType: locationContext.currentPage?.type,
      breadcrumbs: locationContext.breadcrumbs,
    } : undefined,
    readOnlyMode,
    personalization ?? undefined
  );

  const timestampSystemPrompt = buildTimestampSystemPrompt(userTimezone);

  const drivePromptSection = locationContext?.currentDrive?.id
    ? await fetchDrivePromptSection(locationContext.currentDrive.id)
    : '';

  const globalAssistantInstructions = buildGlobalAssistantInstructions(locationContext, conversation, drivePromptSection);

  const systemPrompt = baseSystemPrompt + mentionSystemPrompt + timestampSystemPrompt + globalAssistantInstructions;

  const agentAwarenessPrompt = await buildAgentAwarenessPrompt(userId);

  const pageTreePrompt = showPageTree
    ? await buildPageTreePrompt(userId, locationContext)
    : '';

  const finalSystemPrompt = systemPrompt
    + (agentAwarenessPrompt ? '\n\n' + agentAwarenessPrompt : '')
    + pageTreePrompt;

  return { finalSystemPrompt, userTimezone };
}

async function fetchDrivePromptSection(driveId: string): Promise<string> {
  const { getDrivePrompt } = await import('./message-queries');
  return getDrivePrompt(driveId);
}

function buildGlobalAssistantInstructions(
  locationContext: LocationContext | undefined,
  conversation: ValidatedContext['conversation'],
  drivePromptSection: string
): string {
  return `

You are the Global Assistant for PageSpace - accessible from both the dashboard and sidebar.

TASK MANAGEMENT:
• Use create_page with type TASK_LIST to create task lists for tracking work
• Use update_task with pageId to add tasks - each task creates a linked DOCUMENT page
• Use read_page on TASK_LIST pages to view tasks and progress
• Update task status as you progress - users see real-time updates

CRITICAL NESTING PRINCIPLE:
• NO RESTRICTIONS on what can contain what - organize based on logical user needs
• Documents can contain AI chats, channels, folders, and canvas pages
• AI chats can contain documents, other AI chats, folders, and any page type
• Channels can contain any page type for organized discussion threads  
• Canvas pages can contain any page type for custom navigation structures
• Think creatively about nesting - optimize for user workflow, not type conventions

${locationContext ? `
CONTEXT-AWARE BEHAVIOR:
• You are currently in: ${locationContext.currentDrive?.name || 'dashboard'} ${locationContext.currentPage ? `> ${locationContext.currentPage.title}` : ''}
• Default scope: Operations should focus on this location unless user indicates otherwise
• When user says "here" or "this", they mean the current location
• Only explore other drives/areas when explicitly mentioned or necessary for the task
• Start from current context, not from list_drives
` : `
DASHBOARD CONTEXT:
• You are in the dashboard view - focus on cross-workspace tasks and overview
• Use list_drives when you need to work across multiple workspaces
• Help with personal productivity and workspace organization
• create_drive: Use when user explicitly requests new workspace OR when their project clearly doesn't fit existing drives
• Always check existing drives first via list_drives before suggesting new drive creation
• Ask for confirmation unless user is explicit about creating new workspace
`}

SMART EXPLORATION RULES:
1. When in a drive context - ALWAYS explore it first:
   - If locationContext includes a drive, ALWAYS use list_pages on that drive when:
     • User asks about the drive, its contents, or what's available
     • User wants to create, write, or modify ANYTHING
     • User mentions something that MAY exist in the drive
     • User asks general questions about content or organization
     • You need to understand the workspace structure
   - Start with list_pages(driveId: '${locationContext?.currentDrive?.id || 'current-drive-id'}') BEFORE other actions
2. Context-first approach:
   - Default scope: Current drive/location is your primary workspace
   - Only explore OTHER drives when explicitly mentioned
   - When user says "here" or "this", they mean current context
3. Efficient exploration pattern:
   - FIRST: list_pages with driveId on current drive (if in a drive)
   - THEN: read specific pages as needed
   - ONLY IF NEEDED: explore other drives/workspaces
4. Proactive assistance:
   - Don't ask "what's in your drive" - use list_pages to discover
   - Suggest creating AI_CHAT and CHANNEL pages for organization
   - Be autonomous within current context

CONVERSATION TYPE: ${conversation.type.toUpperCase()}${conversation.contextId ? ` (Context: ${conversation.contextId})` : ''}

MENTION PROCESSING:
• When users @mention documents using @[Label](id:type) format, you MUST read those documents first
• Use the read_page tool for each mentioned document before providing your main response
• Let mentioned document content inform and enrich your response
• Don't explicitly mention that you're reading @mentioned docs unless relevant to the conversation` + drivePromptSection;
}

async function buildPageTreePrompt(
  userId: string,
  locationContext: LocationContext | undefined
): Promise<string> {
  if (locationContext?.currentDrive?.id) {
    const treeContext = await getPageTreeContext(userId, {
      scope: 'drive',
      driveId: locationContext.currentDrive.id,
    });
    if (treeContext) {
      loggers.api.debug('Global Assistant: Page tree context included', {
        driveId: locationContext.currentDrive.id,
        contextLength: treeContext.length
      });
      return `\n\n## WORKSPACE STRUCTURE\n\nHere is the complete workspace structure:\n\n${treeContext}`;
    }
  } else {
    const driveSummary = await getDriveListSummary(userId);
    if (driveSummary) {
      loggers.api.debug('Global Assistant: Drive list summary included', {
        summaryLength: driveSummary.length
      });
      return `\n\n## ACCESSIBLE WORKSPACES\n\n${driveSummary}`;
    }
  }
  return '';
}
