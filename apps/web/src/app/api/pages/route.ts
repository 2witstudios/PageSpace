import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { getCreatablePageTypes } from '@pagespace/lib/content/page-types.config'
import { PageType } from '@pagespace/lib/utils/enums'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { pageService, type CreatePageParams } from '@/services/api';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { filterToolsForMcpScope } from '@/lib/ai/core/tool-filtering';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPCreateScope, isMCPAuthResult } from '@/lib/auth/auth-core';
import { isScopedMCPAuth, canPrincipalEditPage } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };
const creatablePageTypes = [
  ...getCreatablePageTypes(),
  PageType.MACHINE,
] as unknown as [string, ...string[]];

// Zod schema for page creation request
const createPageSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  type: z.enum(creatablePageTypes),
  driveId: z.string().min(1, 'Drive ID is required'),
  parentId: z.string().nullable().optional(),
  content: z.string().optional(),
  contentMode: z.enum(['html', 'markdown']).optional(),
  systemPrompt: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    const body = await request.json();

    // Validate request body with Zod
    const parseResult = createPageSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const validatedData = parseResult.data;
    if (validatedData.type === PageType.MACHINE && auth.role !== 'admin') {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'page', resourceId: validatedData.driveId, details: { reason: 'app_admin_required', type: validatedData.type, method: 'POST' }, riskScore: 0.5 });
      return NextResponse.json({ error: 'Terminal pages require administrator privileges' }, { status: 403 });
    }

    // Check MCP token scope - scoped tokens can only create pages in allowed drives
    const scopeError = checkMCPCreateScope(auth, validatedData.driveId);
    if (scopeError) {
      return scopeError;
    }

    // A drive-scoped MCP token cannot newly enable an account-level-only tool
    // (e.g. create_drive) — mirrors the runtime chat/consult tool-list filtering.
    if (validatedData.enabledTools && validatedData.enabledTools.length > 0) {
      const availableToolNames = Object.keys(filterToolsForMcpScope(pageSpaceTools, isScopedMCPAuth(auth)));
      const invalidTools = validatedData.enabledTools.filter((toolName) => !availableToolNames.includes(toolName));
      if (invalidTools.length > 0) {
        return NextResponse.json(
          { error: `Invalid tools: ${invalidTools.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // Track MCP source so the unread indicator (blue dot) shows for MCP-created pages.
    // Without this, MCP-created pages are filtered out as "the user's own changes" since
    // MCP tokens authenticate as the owning user.
    // The principal authorizer makes scoped tokens create under their OWN
    // drive-membership role (app member RBAC) instead of the owning user's.
    const isMCP = isMCPAuthResult(auth);
    const createOptions = {
      ...(isMCP ? { context: { metadata: { source: 'mcp' } } } : undefined),
      authorizeEdit: (targetId: string) => canPrincipalEditPage(auth, targetId),
    };

    const result = await pageService.createPage(userId, {
      title: validatedData.title,
      type: validatedData.type as CreatePageParams['type'],
      driveId: validatedData.driveId,
      parentId: validatedData.parentId,
      content: validatedData.content,
      contentMode: validatedData.contentMode,
      systemPrompt: validatedData.systemPrompt,
      enabledTools: validatedData.enabledTools,
      aiProvider: validatedData.aiProvider,
      aiModel: validatedData.aiModel,
    }, createOptions);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Side effects: use result values (normalized/canonical) instead of request body
    await broadcastPageEvent(
      createPageEventPayload(result.driveId, result.page.id, 'created', {
        parentId: result.page.parentId ?? undefined,
        title: result.page.title ?? undefined,
        type: result.page.type,
      }),
    );

    // Track page creation using result values
    trackPageOperation(userId, 'create', result.page.id, {
      title: result.page.title,
      type: result.page.type,
      driveId: result.driveId,
      parentId: result.page.parentId,
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page', resourceId: result.page.id, details: { title: result.page.title, type: result.page.type, driveId: result.driveId } });

    return NextResponse.json(result.page, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 });
  }
}
