import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyAdminAuth, isAdminAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers, auditRequest } from '@pagespace/lib/server';
import {
  getBuiltinProvider,
  getProviderBySlug,
  createProvider,
} from '@pagespace/lib/integrations';

const installSchema = z.object({
  builtinId: z.string().min(1),
});

/**
 * POST /api/integrations/providers/install
 * Installs a builtin provider by copying its config into the database.
 * Admin only — verifyAdminAuth handles session + CSRF + role-version validation.
 */
export async function POST(request: Request) {
  const adminUser = await verifyAdminAuth(request);
  if (isAdminAuthError(adminUser)) return adminUser;

  try {
    const body = await request.json();
    const validation = installSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { builtinId } = validation.data;

    const builtin = getBuiltinProvider(builtinId);
    if (!builtin) {
      return NextResponse.json({ error: 'Unknown builtin provider' }, { status: 404 });
    }

    // Check if already installed
    const existing = await getProviderBySlug(db, builtin.id);
    if (existing) {
      return NextResponse.json({ error: 'Provider already installed' }, { status: 409 });
    }

    const provider = await createProvider(db, {
      slug: builtin.id,
      name: builtin.name,
      description: builtin.description ?? null,
      iconUrl: builtin.iconUrl ?? null,
      documentationUrl: builtin.documentationUrl ?? null,
      providerType: 'builtin',
      config: builtin as unknown as Record<string, unknown>,
      isSystem: true,
      createdBy: adminUser.id,
      driveId: null,
      enabled: true,
    });

    auditRequest(request, { eventType: 'data.write', userId: adminUser.id, resourceType: 'integration_install', resourceId: provider.id, details: { builtinId, operation: 'install' } });

    return NextResponse.json({ provider: { id: provider.id, slug: provider.slug, name: provider.name } }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error installing builtin provider:', error as Error);
    return NextResponse.json({ error: 'Failed to install provider' }, { status: 500 });
  }
}
