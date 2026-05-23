import { NextResponse } from 'next/server';
import { authenticateSessionRequest, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getManagedProviderKey } from '@/lib/ai/core/ai-utils';
import { filterFreeModels } from './filter-utils';

export async function GET(request: Request) {
  try {
    const auth = await authenticateSessionRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const settings = getManagedProviderKey('openrouter');
    if (!settings?.apiKey) {
      return NextResponse.json(
        { success: false, error: 'OpenRouter is not configured on this deployment.', models: {} },
        { status: 503 }
      );
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      });

      if (!response.ok) {
        throw new Error(`OpenRouter responded with status ${response.status}`);
      }

      const data = await response.json();
      const models = filterFreeModels(Array.isArray(data?.data) ? data.data : []);

      loggers.ai.info('Successfully fetched OpenRouter free models', {
        userId,
        modelCount: Object.keys(models).length,
      });

      return NextResponse.json({ success: true, models, modelCount: Object.keys(models).length });
    } catch (fetchError) {
      loggers.ai.error('Failed to fetch models from OpenRouter', fetchError as Error, { userId });

      return NextResponse.json(
        { success: false, error: 'Could not fetch OpenRouter models.', models: {} },
        { status: 200 }
      );
    }
  } catch (error) {
    loggers.ai.error('OpenRouter models fetch error', error as Error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch OpenRouter models', models: {} },
      { status: 500 }
    );
  }
}
