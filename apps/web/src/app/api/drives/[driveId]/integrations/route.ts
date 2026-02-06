import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import {
  listDriveConnections,
  createConnection,
  getProviderById,
  findDriveConnection,
  encryptCredentials,
  buildOAuthAuthorizationUrl,
  createSignedState,
} from '@pagespace/lib/integrations';
import type { IntegrationProviderConfig } from '@pagespace/lib/integrations';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const createConnectionSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1).max(100),
  credentials: z.record(z.string(), z.string()).optional(),
  baseUrlOverride: z.string().url().optional(),
  returnUrl: z.string().startsWith('/').optional(),
});

/**
 * GET /api/drives/[driveId]/integrations
 * List all integration connections for a drive.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    // Verify drive membership
    const access = await getDriveAccess(driveId, auth.userId);
    if (!access.isMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const connections = await listDriveConnections(db, driveId);

    const safeConnections = connections.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      name: c.name,
      status: c.status,
      statusMessage: c.statusMessage,
      accountMetadata: c.accountMetadata,
      baseUrlOverride: c.baseUrlOverride,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
      provider: c.provider ? {
        id: c.provider.id,
        slug: c.provider.slug,
        name: c.provider.name,
        description: c.provider.description,
      } : null,
    }));

    return NextResponse.json({ connections: safeConnections });
  } catch (error) {
    loggers.api.error('Error listing drive integrations:', error as Error);
    return NextResponse.json({ error: 'Failed to list integrations' }, { status: 500 });
  }
}

/**
 * POST /api/drives/[driveId]/integrations
 * Create a new integration connection for a drive.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    // Require OWNER or ADMIN role
    const access = await getDriveAccess(driveId, auth.userId);
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await request.json();
    const validation = createConnectionSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { providerId, name, credentials, baseUrlOverride, returnUrl } = validation.data;

    const provider = await getProviderById(db, providerId);
    if (!provider || !provider.enabled) {
      return NextResponse.json({ error: 'Provider not found or disabled' }, { status: 404 });
    }

    if (provider.driveId && provider.driveId !== driveId) {
      return NextResponse.json({ error: 'Provider not available for this drive' }, { status: 404 });
    }

    const existing = await findDriveConnection(db, driveId, providerId);
    if (existing) {
      return NextResponse.json({ error: 'Connection already exists for this provider' }, { status: 409 });
    }

    const config = provider.config as IntegrationProviderConfig;

    // OAuth providers: redirect
    if (config.authMethod.type === 'oauth2') {
      if (!process.env.OAUTH_STATE_SECRET) {
        return NextResponse.json({ error: 'OAuth not configured' }, { status: 500 });
      }

      const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
      const redirectUri = `${baseUrl}/api/user/integrations/callback`;

      const state = createSignedState(
        {
          userId: auth.userId,
          providerId,
          name,
          driveId,
          returnUrl: returnUrl || `/drives/${driveId}/settings`,
        },
        process.env.OAUTH_STATE_SECRET
      );

      const oauthConfig = config.authMethod.config;
      const envSlug = provider.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const clientId = process.env[`INTEGRATION_${envSlug}_CLIENT_ID`] || '';

      if (!clientId) {
        loggers.api.error('Missing OAuth client ID for provider', { slug: provider.slug, envVar: `INTEGRATION_${envSlug}_CLIENT_ID` });
        return NextResponse.json({ error: 'OAuth not configured for this provider' }, { status: 500 });
      }

      const url = buildOAuthAuthorizationUrl(oauthConfig, {
        clientId,
        redirectUri,
        state,
      });

      return NextResponse.json({ url });
    }

    // Non-OAuth providers
    if (!credentials || Object.keys(credentials).length === 0) {
      return NextResponse.json({ error: 'Credentials are required' }, { status: 400 });
    }

    const encrypted = await encryptCredentials(credentials);

    const connection = await createConnection(db, {
      providerId,
      driveId,
      name,
      status: 'active',
      credentials: encrypted,
      baseUrlOverride: baseUrlOverride ?? null,
      connectedBy: auth.userId,
      connectedAt: new Date(),
    });

    return NextResponse.json({
      connection: {
        id: connection.id,
        providerId: connection.providerId,
        name: connection.name,
        status: connection.status,
        createdAt: connection.createdAt,
      },
    }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating drive integration:', error as Error);
    return NextResponse.json({ error: 'Failed to create integration' }, { status: 500 });
  }
}
