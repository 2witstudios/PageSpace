import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { listEnabledProviders, createProvider } from '@pagespace/lib/integrations';

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
    const providers = await listEnabledProviders(db);

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

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating provider:', error as Error);
    return NextResponse.json({ error: 'Failed to create provider' }, { status: 500 });
  }
}
