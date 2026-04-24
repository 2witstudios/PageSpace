import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listEnabledProviders, createProvider, seedBuiltinProviders, refreshBuiltinProviders } from '@pagespace/lib/integrations/repositories/provider-repository';
import { builtinProviderList } from '@pagespace/lib/integrations/providers';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const createProviderSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  iconUrl: z.string().url().optional(),
  documentationUrl: z.string().url().optional(),
  providerType: z.enum(['openapi', 'custom', 'webhook']),
  config: z.record(z.string(), z.unknown()),
  driveId: z.string().optional(),
});

/**
 * GET /api/integrations/providers
 * List all enabled integration providers.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    // Auto-seed builtin providers if none are installed yet (lazy init)
    let providers = await listEnabledProviders(db);
    if (providers.length === 0 && builtinProviderList.length > 0) {
      try {
        const seeded = await seedBuiltinProviders(db, builtinProviderList);
        if (seeded.length > 0) {
          loggers.api.info('Auto-seeded builtin integration providers', {
            count: seeded.length,
            slugs: seeded.map((p) => p.slug),
          });
          providers = await listEnabledProviders(db);
        }
      } catch (seedError) {
        loggers.api.warn('Failed to auto-seed builtin providers (non-fatal)', {
          error: seedError instanceof Error ? seedError.message : String(seedError),
        });
      }
    }

    // Refresh builtin providers with latest tool definitions (e.g. after deploy)
    try {
      const refreshed = await refreshBuiltinProviders(db, builtinProviderList);
      if (refreshed > 0) {
        loggers.api.info('Refreshed builtin provider configs', { count: refreshed });
        providers = await listEnabledProviders(db);
      }
    } catch (refreshError) {
      loggers.api.warn('Failed to refresh builtin providers (non-fatal)', {
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    }

    // Strip config details for listing (security)
    const safeProviders = providers.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      iconUrl: p.iconUrl,
      documentationUrl: p.documentationUrl,
      providerType: p.providerType,
      isSystem: p.isSystem,
      enabled: p.enabled,
      createdAt: p.createdAt,
    }));

    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'integration_provider', resourceId: 'list', details: { providerCount: safeProviders.length } });

    return NextResponse.json({ providers: safeProviders });
  } catch (error) {
    loggers.api.error('Error listing providers:', error as Error);
    return NextResponse.json({ error: 'Failed to list providers' }, { status: 500 });
  }
}

/**
 * POST /api/integrations/providers
 * Create a custom integration provider. Admin only.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  // Only admins can create providers
  const adminAuth = await verifyAdminAuth(request);
  if (!adminAuth) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const validation = createProviderSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { slug, name, description, iconUrl, documentationUrl, providerType, config, driveId } = validation.data;

    const provider = await createProvider(db, {
      slug,
      name,
      description: description ?? null,
      iconUrl: iconUrl ?? null,
      documentationUrl: documentationUrl ?? null,
      providerType,
      config,
      isSystem: false,
      createdBy: auth.userId,
      driveId: driveId ?? null,
      enabled: true,
    });

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'integration_provider', resourceId: provider.id, details: { slug, providerType, operation: 'create' } });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating provider:', error as Error);
    return NextResponse.json({ error: 'Failed to create provider' }, { status: 500 });
  }
}
