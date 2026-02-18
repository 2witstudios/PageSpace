import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  getProviderById,
  updateProvider,
  deleteProvider,
  countProviderConnections,
} from '@pagespace/lib/integrations';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const toolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  category: z.enum(['read', 'write', 'admin', 'dangerous']),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  execution: z.object({
    type: z.literal('http'),
    config: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      pathTemplate: z.string().min(1),
    }),
  }),
});

const updateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  iconUrl: z.string().url().nullable().optional(),
  documentationUrl: z.string().url().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  addTools: z.array(toolSchema).optional(),
});

/**
 * GET /api/integrations/providers/[providerId]
 * Get a specific integration provider.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ providerId: string }> }
) {
  const { providerId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const provider = await getProviderById(db, providerId);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    return NextResponse.json({ provider });
  } catch (error) {
    loggers.api.error('Error fetching provider:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch provider' }, { status: 500 });
  }
}

/**
 * PUT /api/integrations/providers/[providerId]
 * Update a custom integration provider.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ providerId: string }> }
) {
  const { providerId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const provider = await getProviderById(db, providerId);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    // System providers can't be modified
    if (provider.isSystem) {
      return NextResponse.json({ error: 'System providers cannot be modified' }, { status: 403 });
    }

    // Only creator or admin can modify
    if (provider.createdBy !== auth.userId) {
      const adminAuth = await verifyAdminAuth(request);
      if (!adminAuth) {
        return NextResponse.json({ error: 'Not authorized to modify this provider' }, { status: 403 });
      }
    }

    const body = await request.json();
    const validation = updateProviderSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { addTools, ...updateData } = validation.data;

    // If addTools is provided, merge new tools into existing config.tools
    if (addTools && addTools.length > 0) {
      const baseConfig = (provider.config as Record<string, unknown>) ?? {};
      const mergedConfig = { ...baseConfig, ...(updateData.config ?? {}) };
      const existingTools = Array.isArray(mergedConfig.tools) ? mergedConfig.tools as { id: string }[] : [];
      const newToolIds = new Set(addTools.map((t) => t.id));
      const filteredExisting = existingTools.filter((t) => !newToolIds.has(t.id));
      updateData.config = {
        ...mergedConfig,
        tools: [...filteredExisting, ...addTools],
      };
    }

    const updated = await updateProvider(db, providerId, updateData);
    return NextResponse.json({ provider: updated });
  } catch (error) {
    loggers.api.error('Error updating provider:', error as Error);
    return NextResponse.json({ error: 'Failed to update provider' }, { status: 500 });
  }
}

/**
 * DELETE /api/integrations/providers/[providerId]
 * Delete a custom integration provider.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ providerId: string }> }
) {
  const { providerId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const provider = await getProviderById(db, providerId);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    if (provider.isSystem) {
      return NextResponse.json({ error: 'System providers cannot be deleted' }, { status: 403 });
    }

    if (provider.createdBy !== auth.userId) {
      const adminAuth = await verifyAdminAuth(request);
      if (!adminAuth) {
        return NextResponse.json({ error: 'Not authorized to delete this provider' }, { status: 403 });
      }
    }

    // Check for active connections
    const connectionCount = await countProviderConnections(db, providerId);
    if (connectionCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete provider with ${connectionCount} active connection(s). Remove connections first.` },
        { status: 409 }
      );
    }

    const deleted = await deleteProvider(db, providerId);
    if (!deleted) {
      return NextResponse.json({ error: 'Failed to delete provider' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting provider:', error as Error);
    return NextResponse.json({ error: 'Failed to delete provider' }, { status: 500 });
  }
}
