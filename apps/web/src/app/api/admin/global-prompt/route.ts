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
import { buildCompleteRequest, type CompletePayloadResult, type LocationContext } from '@/lib/ai/complete-request-builder';
import { getToolsSummary } from '@/lib/ai/tool-filtering';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { extractToolSchemas, calculateTotalToolTokens } from '@/lib/ai/schema-introspection';
import { db, driveMembers, drives, pages, eq, and, asc } from '@pagespace/db';
import { estimateSystemPromptTokens } from '@pagespace/lib/ai-context-calculator';
import { buildSystemPrompt } from '@/lib/ai/system-prompt';

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

    // Get all drives the user has access to (for the picker)
    const userDriveResults = await db
      .select({
        driveId: driveMembers.driveId,
        role: driveMembers.role,
        driveName: drives.name,
        driveSlug: drives.slug,
      })
      .from(driveMembers)
      .leftJoin(drives, eq(driveMembers.driveId, drives.id))
      .where(eq(driveMembers.userId, adminUser.id));

    const availableDrives = userDriveResults
      .filter(d => d.driveName !== null)
      .map(d => ({
        id: d.driveId,
        name: d.driveName!,
        slug: d.driveSlug!,
        role: d.role,
      }));

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

      // Build detailed sections with source annotations for the breakdown view
      const sections: PromptSection[] = [
        {
          name: 'System Prompt',
          content: systemPrompt,
          source: 'apps/web/src/lib/ai/system-prompt.ts',
          lines: '73-94',
          tokens: estimateSystemPromptTokens(systemPrompt),
        },
        {
          name: 'Inline Instructions',
          content: '(See complete payload for full instructions)',
          source: 'apps/web/src/lib/ai/inline-instructions.ts',
          lines: '19-53',
          tokens: 0, // Already counted in complete payload
        },
      ];

      // Get tool permissions summary
      const toolsSummary = getToolsSummary(isReadOnly);

      promptData[key] = {
        mode: key,
        fullPrompt: completePayload.request.system,
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
        parameters: toolAny.parameters,
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
      },
    });

  } catch (error) {
    console.error('Error generating global prompt data:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
