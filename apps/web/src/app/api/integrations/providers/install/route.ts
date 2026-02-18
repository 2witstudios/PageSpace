import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  getBuiltinProvider,
  getProviderBySlug,
  createProvider,
} from '@pagespace/lib/integrations';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const installSchema = z.object({
  builtinId: z.string().min(1),
});

/**
 * POST /api/integrations/providers/install
 * Installs a builtin provider by copying its config into the database.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

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
      createdBy: auth.userId,
      driveId: null,
      enabled: true,
    });

    return NextResponse.json({ provider: { id: provider.id, slug: provider.slug, name: provider.name } }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error installing builtin provider:', error as Error);
    return NextResponse.json({ error: 'Failed to install provider' }, { status: 500 });
  }
}
