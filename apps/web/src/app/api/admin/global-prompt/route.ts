/**
 * Admin API Route: Global Prompt Viewer
 *
 * Returns the COMPLETE context window sent to the AI, exactly as the LLM receives it.
 * Includes:
 * - Full system prompt with all inline instructions
 * - Tool definitions with JSON schemas
 * - Experimental context
 * - Token estimates
 */

import { verifyAdminAuth } from '@/lib/auth';
import {
  buildCompleteRequest,
  type CompletePayloadResult,
  type LocationContext,
  getToolsSummary,
  pageSpaceTools,
  extractToolSchemas,
  calculateTotalToolTokens,
  buildSystemPrompt,
  buildAgentAwarenessPrompt,
  getPageTreeContext,
  getDriveListSummary,
  buildInlineInstructions,
  buildGlobalAssistantInstructions,
} from '@/lib/ai/core';
import { db, driveMembers, drives, pages, eq, and, asc } from '@pagespace/db';
import { estimateSystemPromptTokens } from '@pagespace/lib/ai-context-calculator';

interface PromptSection {
  name: string;
  content: string;
  source: string;
  lines?: string;
  tokens: number;
}

interface ModePromptData {
  mode: 'fullAccess' | 'readOnly';
  fullPrompt: string;
  sections: PromptSection[];
  totalTokens: number;
  toolsAllowed: string[];
  toolsDenied: string[];
  permissions: {
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
    canOrganize: boolean;
  };
  // Complete payload for this mode
  completePayload: CompletePayloadResult;
}

export async function GET(request: Request) {
  // Verify admin authentication
  const adminUser = await verifyAdminAuth(request);
  if (!adminUser) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Parse query params for context selection
    const { searchParams } = new URL(request.url);
    const selectedDriveId = searchParams.get('driveId'); // null = dashboard context
    const selectedPageId = searchParams.get('pageId'); // null = drive or dashboard context
    const showPageTree = searchParams.get('showPageTree') === 'true';

    // Get all drives the user has access to (for the picker)
    // 1. Get drives owned by the user
    const ownedDrives = await db.query.drives.findMany({
      where: and(eq(drives.ownerId, adminUser.id), eq(drives.isTrashed, false)),
    });

    // 2. Get drives shared with the user via driveMembers
    const memberDrives = await db
      .select({
        driveId: driveMembers.driveId,
        role: driveMembers.role,
        driveName: drives.name,
        driveSlug: drives.slug,
      })
      .from(driveMembers)
      .leftJoin(drives, eq(driveMembers.driveId, drives.id))
      .where(eq(driveMembers.userId, adminUser.id));

    // 3. Merge owned drives + shared drives, deduplicating
    const allDrivesMap = new Map<string, { id: string; name: string; slug: string; role: string }>();

    // Add owned drives first (role = OWNER)
    for (const drive of ownedDrives) {
      allDrivesMap.set(drive.id, {
        id: drive.id,
        name: drive.name,
        slug: drive.slug,
        role: 'OWNER',
      });
    }

    // Add shared drives (don't override if already owned)
    for (const drive of memberDrives) {
      if (drive.driveName && !allDrivesMap.has(drive.driveId)) {
        allDrivesMap.set(drive.driveId, {
          id: drive.driveId,
          name: drive.driveName,
          slug: drive.driveSlug!,
          role: drive.role,
        });
      }
    }

    const availableDrives = Array.from(allDrivesMap.values());

    // Get pages for the selected drive (for the page picker)
    let availablePages: Array<{ id: string; title: string; type: string; parentId: string | null }> = [];
    if (selectedDriveId) {
      const drivePages = await db
        .select({
          id: pages.id,
          title: pages.title,
          type: pages.type,
          parentId: pages.parentId,
        })
        .from(pages)
        .where(and(
          eq(pages.driveId, selectedDriveId),
          eq(pages.isTrashed, false)
        ))
        .orderBy(asc(pages.title));
      availablePages = drivePages;
    }

    // Helper function to build breadcrumbs for a page
    async function buildBreadcrumbs(pageId: string): Promise<Array<{ id: string; title: string }>> {
      const breadcrumbs: Array<{ id: string; title: string }> = [];
      let currentId: string | null = pageId;

      while (currentId) {
        const page = await db
          .select({ id: pages.id, title: pages.title, parentId: pages.parentId })
          .from(pages)
          .where(eq(pages.id, currentId))
          .limit(1);

        if (page.length === 0) break;

        breadcrumbs.unshift({ id: page[0].id, title: page[0].title });
        currentId = page[0].parentId;
      }

      return breadcrumbs;
    }

    // Helper function to build page path from breadcrumbs
    function buildPagePath(breadcrumbs: Array<{ id: string; title: string }>): string {
      return '/' + breadcrumbs.map(b => b.title).join('/');
    }

    // Build location context based on selection
    let locationContext: LocationContext | undefined = undefined;
    let contextType: 'dashboard' | 'drive' | 'page' = 'dashboard';

    if (selectedPageId && selectedDriveId) {
      // User selected a specific page - build full page context
      const selectedDrive = availableDrives.find(d => d.id === selectedDriveId);
      const selectedPage = availablePages.find(p => p.id === selectedPageId);

      if (selectedDrive && selectedPage) {
        const breadcrumbs = await buildBreadcrumbs(selectedPageId);
        const pagePath = buildPagePath(breadcrumbs);

        locationContext = {
          currentDrive: {
            id: selectedDrive.id,
            name: selectedDrive.name,
            slug: selectedDrive.slug,
          },
          currentPage: {
            id: selectedPage.id,
            title: selectedPage.title,
            type: selectedPage.type,
            path: pagePath,
          },
          breadcrumbs,
        };
        contextType = 'page';
      }
    } else if (selectedDriveId) {
      // User selected a specific drive (no page)
      const selectedDrive = availableDrives.find(d => d.id === selectedDriveId);
      if (selectedDrive) {
        locationContext = {
          currentDrive: {
            id: selectedDrive.id,
            name: selectedDrive.name,
            slug: selectedDrive.slug,
          },
        };
        contextType = 'drive';
      }
    }
    // If no drive selected (or invalid), locationContext remains undefined (dashboard context)

    // Build async context sections (require DB queries, shared across modes)
    const agentAwarenessPrompt = await buildAgentAwarenessPrompt(adminUser.id);

    let pageTreePrompt = '';
    if (showPageTree) {
      if (selectedDriveId) {
        const treeContext = await getPageTreeContext(adminUser.id, {
          scope: 'drive',
          driveId: selectedDriveId,
        });
        if (treeContext) {
          pageTreePrompt = `\n\n## WORKSPACE STRUCTURE\n\nHere is the complete workspace structure:\n\n${treeContext}`;
        }
      } else {
        // Dashboard context - show drive list summary
        const driveSummary = await getDriveListSummary(adminUser.id);
        if (driveSummary) {
          pageTreePrompt = `\n\n## ACCESSIBLE WORKSPACES\n\n${driveSummary}`;
        }
      }
    }

    // Build prompt data for both modes (Full Access and Read-Only)
    const modes: Array<{ key: 'fullAccess' | 'readOnly'; isReadOnly: boolean }> = [
      { key: 'fullAccess', isReadOnly: false },
      { key: 'readOnly', isReadOnly: true },
    ];
    const promptData: Record<string, ModePromptData> = {};

    for (const { key, isReadOnly } of modes) {
      // Build complete payload using shared module (EXACT match with chat route)
      const completePayload = buildCompleteRequest({
        isReadOnly,
        contextType,
        locationContext,
        includeExampleMessage: true,
      });

      // Build system prompt for sections display
      const systemPrompt = buildSystemPrompt(
        contextType,
        locationContext?.currentDrive ? {
          driveName: locationContext.currentDrive.name,
          driveSlug: locationContext.currentDrive.slug,
          driveId: locationContext.currentDrive.id,
          pagePath: locationContext.currentPage?.path,
          pageType: locationContext.currentPage?.type,
          breadcrumbs: locationContext.breadcrumbs?.map(b => b.title),
        } : undefined,
        isReadOnly
      );

      // Build inline instructions based on context type
      let inlineInstructions: string;
      if (contextType === 'page' && locationContext?.currentPage) {
        inlineInstructions = buildInlineInstructions({
          pageTitle: locationContext.currentPage.title,
          pageType: locationContext.currentPage.type,
          isTaskLinked: locationContext.currentPage.isTaskLinked,
          driveName: locationContext.currentDrive?.name,
          pagePath: locationContext.currentPage.path,
          driveSlug: locationContext.currentDrive?.slug,
          driveId: locationContext.currentDrive?.id,
        });
      } else {
        inlineInstructions = buildGlobalAssistantInstructions(
          locationContext?.currentDrive
            ? {
                driveName: locationContext.currentDrive.name,
                driveSlug: locationContext.currentDrive.slug,
                driveId: locationContext.currentDrive.id,
              }
            : undefined
        );
      }

      // Build detailed sections with source annotations for the breakdown view
      const sections: PromptSection[] = [
        {
          name: 'System Prompt',
          content: systemPrompt,
          source: 'apps/web/src/lib/ai/core/system-prompt.ts',
          tokens: estimateSystemPromptTokens(systemPrompt),
        },
        {
          name: 'Inline Instructions',
          content: inlineInstructions,
          source: 'apps/web/src/lib/ai/core/inline-instructions.ts',
          tokens: estimateSystemPromptTokens(inlineInstructions),
        },
      ];

      // Add async context sections
      if (agentAwarenessPrompt) {
        sections.push({
          name: 'Agent Awareness',
          content: agentAwarenessPrompt,
          source: 'apps/web/src/lib/ai/core/agent-awareness.ts',
          tokens: estimateSystemPromptTokens(agentAwarenessPrompt),
        });
      }

      if (pageTreePrompt) {
        sections.push({
          name: 'Page Tree Context',
          content: pageTreePrompt,
          source: 'apps/web/src/lib/ai/core/page-tree-context.ts',
          tokens: estimateSystemPromptTokens(pageTreePrompt),
        });
      }

      // Get tool permissions summary
      const toolsSummary = getToolsSummary(isReadOnly);

      // Append async context sections to the full prompt
      const fullPromptWithAsyncContext =
        completePayload.request.system +
        (agentAwarenessPrompt ? '\n\n' + agentAwarenessPrompt : '') +
        pageTreePrompt;

      // Update completePayload's system prompt to include async context
      completePayload.request.system = fullPromptWithAsyncContext;

      // Show the exact JSON payload sent to the LLM API
      completePayload.formattedString = JSON.stringify(completePayload.request, null, 2);

      // Update token estimates to include async sections
      const asyncTokens =
        (agentAwarenessPrompt ? estimateSystemPromptTokens(agentAwarenessPrompt) : 0) +
        (pageTreePrompt ? estimateSystemPromptTokens(pageTreePrompt) : 0);
      completePayload.tokenEstimates.systemPrompt += asyncTokens;
      completePayload.tokenEstimates.total += asyncTokens;

      promptData[key] = {
        mode: key,
        fullPrompt: fullPromptWithAsyncContext,
        sections,
        totalTokens: completePayload.tokenEstimates.total,
        toolsAllowed: toolsSummary.allowed,
        toolsDenied: toolsSummary.denied,
        permissions: {
          canRead: true,
          canWrite: !isReadOnly,
          canDelete: !isReadOnly,
          canOrganize: !isReadOnly,
        },
        completePayload,
      };
    }

    // Extract full tool schemas for display (all tools, not filtered by mode)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolsForExtraction: Record<string, { description?: string; parameters?: any }> = {};
    for (const [name, tool] of Object.entries(pageSpaceTools)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolAny = tool as any;
      toolsForExtraction[name] = {
        description: toolAny.description,
        parameters: toolAny.inputSchema,  // AI SDK v5 uses inputSchema, not parameters
      };
    }
    const allToolSchemas = extractToolSchemas(toolsForExtraction);
    const totalToolTokens = calculateTotalToolTokens(allToolSchemas);

    // Build experimental context (what gets passed to tool execute functions)
    const experimentalContext = {
      userId: adminUser.id,
      chatId: '[chat-id-placeholder]',
      modelCapabilities: {
        supportsStreaming: true,
        supportsToolCalling: true,
        hasVision: false, // Varies by model
        maxTokens: 128000, // Example value
      },
      locationContext: locationContext || null,
    };

    return Response.json({
      promptData,
      toolSchemas: allToolSchemas,
      totalToolTokens,
      experimentalContext,
      availableDrives,
      availablePages: availablePages.map(p => ({
        id: p.id,
        title: p.title,
        type: p.type,
        path: '', // Path computed on demand
        parentId: p.parentId,
      })),
      metadata: {
        generatedAt: new Date().toISOString(),
        adminUser: {
          id: adminUser.id,
          role: adminUser.role,
        },
        locationContext,
        selectedDriveId,
        selectedPageId,
        contextType,
        showPageTree,
      },
    });

  } catch (error) {
    console.error('Error generating global prompt data:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
