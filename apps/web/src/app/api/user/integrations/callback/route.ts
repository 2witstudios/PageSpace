import { NextResponse } from 'next/server';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  verifySignedState,
  exchangeOAuthCode,
  encryptCredentials,
  getProviderById,
  createConnection,
  findUserConnection,
  updateConnectionCredentials,
  updateConnectionStatus,
} from '@pagespace/lib/integrations';
import type { IntegrationProviderConfig, OAuth2Config } from '@pagespace/lib/integrations';

/**
 * GET /api/user/integrations/callback
 * OAuth callback handler for integration connections.
 */
export async function GET(request: Request) {
  const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const defaultReturn = '/settings/integrations';

  try {
    if (!process.env.OAUTH_STATE_SECRET) {
      loggers.auth.error('Missing OAUTH_STATE_SECRET for integration callback');
      return NextResponse.redirect(new URL(`${defaultReturn}?error=oauth_config`, baseUrl));
    }

    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      loggers.auth.warn('OAuth integration error', { error });
      const errorParam = error === 'access_denied' ? 'access_denied' : 'oauth_error';
      return NextResponse.redirect(new URL(`${defaultReturn}?error=${errorParam}`, baseUrl));
    }

    if (!code || !state) {
      return NextResponse.redirect(new URL(`${defaultReturn}?error=invalid_request`, baseUrl));
    }

    // Verify and decode state
    const stateData = verifySignedState<{
      userId: string;
      providerId: string;
      name: string;
      visibility: string;
      returnUrl: string;
    }>(state, process.env.OAUTH_STATE_SECRET);

    if (!stateData) {
      loggers.auth.warn('Invalid or expired OAuth state for integration callback');
      return NextResponse.redirect(new URL(`${defaultReturn}?error=invalid_state`, baseUrl));
    }

    const { userId, providerId, name, visibility, returnUrl } = stateData;

    // Load provider
    const provider = await getProviderById(db, providerId);
    if (!provider) {
      return NextResponse.redirect(new URL(`${defaultReturn}?error=provider_not_found`, baseUrl));
    }

    const config = provider.config as IntegrationProviderConfig;
    if (config.authMethod.type !== 'oauth2') {
      return NextResponse.redirect(new URL(`${defaultReturn}?error=not_oauth`, baseUrl));
    }

    const oauthConfig = config.authMethod.config as OAuth2Config;
    const redirectUri = `${baseUrl}/api/user/integrations/callback`;

    // Get client credentials from environment
    const clientId = process.env[`INTEGRATION_${provider.slug.toUpperCase()}_CLIENT_ID`] || '';
    const clientSecret = process.env[`INTEGRATION_${provider.slug.toUpperCase()}_CLIENT_SECRET`] || '';

    if (!clientId || !clientSecret) {
      loggers.auth.error('Missing OAuth client credentials for provider', { slug: provider.slug });
      return NextResponse.redirect(new URL(`${defaultReturn}?error=oauth_config`, baseUrl));
    }

    // Exchange code for tokens
    const tokens = await exchangeOAuthCode(oauthConfig, {
      code,
      clientId,
      clientSecret,
      redirectUri,
    });

    if (!tokens.accessToken) {
      return NextResponse.redirect(new URL(`${defaultReturn}?error=missing_tokens`, baseUrl));
    }

    // Encrypt credentials
    const credentialsToEncrypt: Record<string, string> = {
      access_token: tokens.accessToken,
    };
    if (tokens.refreshToken) {
      credentialsToEncrypt.refresh_token = tokens.refreshToken;
    }
    if (tokens.expiresIn) {
      credentialsToEncrypt.expires_at = String(Date.now() + tokens.expiresIn * 1000);
    }

    const encrypted = await encryptCredentials(credentialsToEncrypt);

    // Upsert connection
    const existing = await findUserConnection(db, userId, providerId);
    if (existing) {
      await updateConnectionCredentials(db, existing.id, encrypted);
      await updateConnectionStatus(db, existing.id, 'active');
    } else {
      await createConnection(db, {
        providerId,
        userId,
        name,
        status: 'active',
        credentials: encrypted,
        visibility: (visibility as 'private' | 'owned_drives' | 'all_drives') || 'owned_drives',
        connectedBy: userId,
        connectedAt: new Date(),
      });
    }

    loggers.auth.info('Integration connected via OAuth', { userId, providerId, slug: provider.slug });

    const redirectPath = returnUrl || defaultReturn;
    const redirectUrl = new URL(redirectPath, baseUrl);
    redirectUrl.searchParams.set('connected', 'true');

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    loggers.auth.error('Integration OAuth callback error', error as Error);
    return NextResponse.redirect(new URL(`${defaultReturn}?error=unexpected`, baseUrl));
  }
}
