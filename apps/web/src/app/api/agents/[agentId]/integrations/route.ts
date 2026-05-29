import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { listGrantsByAgent, createGrant, findGrant } from '@pagespace/lib/integrations/repositories/grant-repository';
import { getConnectionWithProvider } from '@pagespace/lib/integrations/repositories/connection-repository';
import { getBuiltinProvider } from '@pagespace/lib/integrations/providers/builtin-providers';
import type { ToolDefinition, ToolBundle } from '@pagespace/lib/integrations/types';
import { broadcastAgentGrantChanged } from '@/lib/websocket/socket-utils';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type SafeProviderTool = Pick<ToolDefinition, 'id' | 'name' | 'description' | 'category'>;
type SafeProviderBundle = Pick<ToolBundle, 'id' | 'name' | 'description' | 'toolIds' | 'recommended'>;

const VALID_CATEGORIES: ReadonlySet<ToolDefinition['category']> = new Set([
  'read',
  'write',
  'admin',
  'dangerous',
]);

const isWellFormedTool = (t: unknown): t is ToolDefinition =>
  !!t &&
  typeof t === 'object' &&
  typeof (t as ToolDefinition).id === 'string' &&
  typeof (t as ToolDefinition).name === 'string' &&
  typeof (t as ToolDefinition).description === 'string' &&
  VALID_CATEGORIES.has((t as ToolDefinition).category);

const isWellFormedBundle = (b: unknown): b is ToolBundle =>
  !!b &&
  typeof b === 'object' &&
  typeof (b as ToolBundle).id === 'string' &&
  typeof (b as ToolBundle).name === 'string' &&
  typeof (b as ToolBundle).description === 'string' &&
  Array.isArray((b as ToolBundle).toolIds) &&
  (b as ToolBundle).toolIds.every((id) => typeof id === 'string');

const sanitizeProviderTools = (config: unknown): SafeProviderTool[] => {
  const rawTools = (config as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(rawTools)) return [];
  return rawTools.filter(isWellFormedTool).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
  }));
};

const sanitizeProviderBundles = (config: unknown): SafeProviderBundle[] => {
  const rawBundles = (config as { toolBundles?: unknown } | null)?.toolBundles;
  if (!Array.isArray(rawBundles)) return [];
  return rawBundles.filter(isWellFormedBundle).map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    toolIds: b.toolIds,
    recommended: b.recommended,
  }));
};

/**
 * Tools a freshly enabled integration should grant when the caller does not
 * specify any: the provider's recommended bundle (Read-only for GitHub), or its
 * first bundle, falling back to null (all non-dangerous tools) for providers
 * with no bundles. Starting least-privilege also means agents load fewer tools.
 *
 * Dangerous tools are never auto-granted as a default — enabling one must always
 * be an explicit human choice — so they are stripped even if a bundle lists them.
 */
const defaultAllowedToolsForProvider = (config: unknown): string[] | null => {
  const bundles = sanitizeProviderBundles(config);
  if (bundles.length === 0) return null;
  const preferred = bundles.find((b) => b.recommended) ?? bundles[0];
  const dangerous = new Set(
    sanitizeProviderTools(config)
      .filter((t) => t.category === 'dangerous')
      .map((t) => t.id)
  );
  return preferred.toolIds.filter((id) => !dangerous.has(id));
};

const createGrantSchema = z.object({
  connectionId: z.string().min(1),
  // Omitted (undefined) → default to the provider's recommended bundle.
  // Explicit null → all non-dangerous tools (legacy behaviour, caller's choice).
  allowedTools: z.array(z.string()).nullable().optional(),
  deniedTools: z.array(z.string()).nullable().optional().default(null),
  readOnly: z.boolean().optional().default(false),
  rateLimitOverride: z.object({
    requestsPerMinute: z.number().min(1).max(1000).optional(),
  }).nullable().optional(),
});

/**
 * GET /api/agents/[agentId]/integrations
 * List all integration grants for an agent.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'agent_integrations', resourceId: agentId });

  try {
    // Verify user can view the agent
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const grants = await listGrantsByAgent(db, agentId);

    return NextResponse.json({
      grants: grants.map((g) => {
        const provider = g.connection?.provider ?? null;
        // Prefer the canonical builtin definition (current tools + bundles) over
        // the persisted DB config, which on upgraded installs may lack bundles or
        // carry stale tool names until GET /api/integrations/providers refreshes
        // it. This is what the per-agent panel reads, so the presets must show
        // immediately after deploy. Falls back to DB config for custom providers.
        const providerConfig = provider
          ? getBuiltinProvider(provider.slug) ?? provider.config
          : null;
        return {
          id: g.id,
          agentId: g.agentId,
          connectionId: g.connectionId,
          allowedTools: g.allowedTools,
          deniedTools: g.deniedTools,
          readOnly: g.readOnly,
          rateLimitOverride: g.rateLimitOverride,
          createdAt: g.createdAt,
          connection: g.connection ? {
            id: g.connection.id,
            name: g.connection.name,
            status: g.connection.status,
            provider: provider ? {
              slug: provider.slug,
              name: provider.name,
              tools: sanitizeProviderTools(providerConfig),
              toolBundles: sanitizeProviderBundles(providerConfig),
            } : null,
          } : null,
        };
      }),
    });
  } catch (error) {
    loggers.api.error('Error listing agent integration grants:', error as Error);
    return NextResponse.json({ error: 'Failed to list grants' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[agentId]/integrations
 * Create a new integration grant for an agent.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const body = await request.json();
    const validation = createGrantSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { connectionId, allowedTools, deniedTools, readOnly, rateLimitOverride } = validation.data;

    // Verify connection exists and is active (provider eager-loaded so we can
    // derive the default bundle below).
    const connection = await getConnectionWithProvider(db, connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }
    if (connection.status !== 'active') {
      return NextResponse.json({ error: 'Connection is not active' }, { status: 400 });
    }

    // Verify the requesting user owns this connection (user-scoped)
    // or is a member of the drive that owns it (drive-scoped)
    const isUserConnection = connection.userId === auth.userId;
    let isDriveMember = false;
    if (connection.driveId) {
      const access = await getDriveAccess(connection.driveId, auth.userId);
      isDriveMember = access.isMember;
    }
    if (!isUserConnection && !isDriveMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Check for existing grant
    const existing = await findGrant(db, agentId, connectionId);
    if (existing) {
      return NextResponse.json({ error: 'Grant already exists for this connection' }, { status: 409 });
    }

    // Prefer the canonical builtin provider definition (always current, carries
    // toolBundles) over the persisted DB config, which on upgraded installs may
    // not yet have bundles until GET /api/integrations/providers refreshes it.
    // Without this, the default would fall back to null (all non-dangerous tools)
    // instead of the intended Read-only bundle.
    const canonicalConfig =
      getBuiltinProvider(connection.provider?.slug ?? '') ?? connection.provider?.config;
    const resolvedAllowedTools =
      allowedTools === undefined
        ? defaultAllowedToolsForProvider(canonicalConfig)
        : allowedTools;

    const grant = await createGrant(db, {
      agentId,
      connectionId,
      allowedTools: resolvedAllowedTools,
      deniedTools,
      readOnly,
      rateLimitOverride,
    });

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'agent_grant', resourceId: agentId });

    void broadcastAgentGrantChanged({ agentId, triggeredBy: { userId: auth.userId } });

    return NextResponse.json({ grant }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating agent integration grant:', error as Error);
    return NextResponse.json({ error: 'Failed to create grant' }, { status: 500 });
  }
}
