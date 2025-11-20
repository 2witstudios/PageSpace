/**
 * Admin API Route: Global Prompt Viewer
 *
 * Returns the complete system prompt sent to the Global Assistant
 * with detailed annotations showing source files and line numbers.
 */

import { verifyAdminAuth } from '@/lib/auth';
import { AgentRole, ROLE_PERMISSIONS } from '@/lib/ai/agent-roles';
import { RolePromptBuilder, ROLE_PROMPTS } from '@/lib/ai/role-prompts';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { buildTimestampSystemPrompt } from '@/lib/ai/timestamp-utils';
import { buildMentionSystemPrompt } from '@/lib/ai/mention-processor';
import { db, driveMembers, eq } from '@pagespace/db';
import { estimateSystemPromptTokens } from '@pagespace/lib/ai-context-calculator';

interface PromptSection {
  name: string;
  content: string;
  source: string;
  lines?: string;
  tokens: number;
}

interface RolePromptData {
  role: AgentRole;
  fullPrompt: string;
  sections: PromptSection[];
  totalTokens: number;
  toolsAllowed: string[];
  toolsDenied: string[];
  permissions: typeof ROLE_PERMISSIONS[AgentRole];
}

export async function GET(request: Request) {
  // Verify admin authentication
  const adminUser = await verifyAdminAuth(request);
  if (!adminUser) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Get the admin user's default drive for real context
    const userDriveResult = await db
      .select()
      .from(driveMembers)
      .where(eq(driveMembers.userId, adminUser.id))
      .limit(1);

    let locationContext = undefined;

    if (userDriveResult.length > 0) {
      const drive = userDriveResult[0];
      locationContext = {
        currentDrive: {
          id: drive.driveId,
          name: drive.driveId, // We'll get the actual name in a moment
          slug: drive.driveId,
        },
      };
    }

    // Build prompt data for all three roles
    const roles = [AgentRole.PARTNER, AgentRole.PLANNER, AgentRole.WRITER];
    const promptData: Record<string, RolePromptData> = {};

    for (const role of roles) {
      const rolePrompt = ROLE_PROMPTS[role];

      // Build the base system prompt (same as used in actual conversations)
      const contextType = 'dashboard'; // Admin viewing from dashboard context
      const baseSystemPrompt = RolePromptBuilder.buildSystemPrompt(
        role,
        contextType,
        locationContext ? {
          driveName: locationContext.currentDrive?.name,
          driveSlug: locationContext.currentDrive?.slug,
          driveId: locationContext.currentDrive?.id,
        } : undefined
      );

      // Build additional prompt sections
      const timestampSystemPrompt = buildTimestampSystemPrompt();
      const mentionSystemPrompt = buildMentionSystemPrompt([
        { id: 'example-page-id', label: 'Example Document', type: 'page' }
      ]);

      // Build the complete global assistant prompt (matching actual implementation)
      const globalAssistantAdditions = `

You are the Global Assistant for PageSpace - accessible from both the dashboard and sidebar.

TASK MANAGEMENT:
• Use create_task_list for any multi-step work (3+ actions) - this creates interactive UI components in the conversation
• Break complex requests into trackable tasks immediately upon receiving them
• Update task status as you progress through work - users see real-time updates
• Task lists persist across conversations and appear as conversation messages

CRITICAL NESTING PRINCIPLE:
• NO RESTRICTIONS on what can contain what - organize based on logical user needs
• Documents can contain AI chats, channels, folders, and canvas pages
• AI chats can contain documents, other AI chats, folders, and any page type
• Channels can contain any page type for organized discussion threads
• Canvas pages can contain any page type for custom navigation structures
• Think creatively about nesting - optimize for user workflow, not type conventions

${locationContext ? `
CONTEXT-AWARE BEHAVIOR:
• You are currently in: ${locationContext.currentDrive?.name || 'dashboard'}
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

CONVERSATION TYPE: GLOBAL (Context: Dashboard or Current Drive)

MENTION PROCESSING:
• When users @mention documents using @[Label](id:type) format, you MUST read those documents first
• Use the read_page tool for each mentioned document before providing your main response
• Let mentioned document content inform and enrich your response
• Don't explicitly mention that you're reading @mentioned docs unless relevant to the conversation`;

      const fullPrompt = baseSystemPrompt + mentionSystemPrompt + timestampSystemPrompt + globalAssistantAdditions;

      // Calculate token estimates
      const totalTokens = estimateSystemPromptTokens(fullPrompt);

      // Build detailed sections with source annotations
      const sections: PromptSection[] = [
        {
          name: 'Role Core Identity',
          content: rolePrompt.core,
          source: 'apps/web/src/lib/ai/role-prompts.ts',
          lines: role === AgentRole.PARTNER ? '23-24' : role === AgentRole.PLANNER ? '59' : '94',
          tokens: estimateSystemPromptTokens(rolePrompt.core),
        },
        {
          name: 'Role Behavior',
          content: rolePrompt.behavior,
          source: 'apps/web/src/lib/ai/role-prompts.ts',
          lines: role === AgentRole.PARTNER ? '26-31' : role === AgentRole.PLANNER ? '61-66' : '96-101',
          tokens: estimateSystemPromptTokens(rolePrompt.behavior),
        },
        {
          name: 'Role Tone',
          content: rolePrompt.tone,
          source: 'apps/web/src/lib/ai/role-prompts.ts',
          lines: role === AgentRole.PARTNER ? '33-37' : role === AgentRole.PLANNER ? '68-73' : '103-108',
          tokens: estimateSystemPromptTokens(rolePrompt.tone),
        },
        {
          name: 'Role Constraints',
          content: rolePrompt.constraints,
          source: 'apps/web/src/lib/ai/role-prompts.ts',
          lines: role === AgentRole.PARTNER ? '39-44' : role === AgentRole.PLANNER ? '75-80' : '110-115',
          tokens: estimateSystemPromptTokens(rolePrompt.constraints),
        },
        {
          name: 'Post-Tool Execution Guidance',
          content: rolePrompt.postToolExecution,
          source: 'apps/web/src/lib/ai/role-prompts.ts',
          lines: role === AgentRole.PARTNER ? '46-49' : role === AgentRole.PLANNER ? '82-85' : '117-118',
          tokens: estimateSystemPromptTokens(rolePrompt.postToolExecution),
        },
        {
          name: 'Timestamp Context',
          content: timestampSystemPrompt,
          source: 'apps/web/src/lib/ai/timestamp-utils.ts',
          lines: '10-23',
          tokens: estimateSystemPromptTokens(timestampSystemPrompt),
        },
        {
          name: 'Mention Processing (Example)',
          content: mentionSystemPrompt,
          source: 'apps/web/src/lib/ai/mention-processor.ts',
          lines: '80-101',
          tokens: estimateSystemPromptTokens(mentionSystemPrompt),
        },
        {
          name: 'Global Assistant Instructions',
          content: globalAssistantAdditions,
          source: 'apps/web/src/app/api/ai_conversations/[id]/messages/route.ts',
          lines: '489-552',
          tokens: estimateSystemPromptTokens(globalAssistantAdditions),
        },
      ];

      // Get tool permissions
      const toolsSummary = ToolPermissionFilter.getToolsSummary(role);

      promptData[role] = {
        role,
        fullPrompt,
        sections,
        totalTokens,
        toolsAllowed: toolsSummary.allowed,
        toolsDenied: toolsSummary.denied,
        permissions: ROLE_PERMISSIONS[role],
      };
    }

    return Response.json({
      promptData,
      metadata: {
        generatedAt: new Date().toISOString(),
        adminUser: {
          id: adminUser.id,
          role: adminUser.role,
        },
        locationContext,
      },
    });

  } catch (error) {
    console.error('Error generating global prompt data:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
