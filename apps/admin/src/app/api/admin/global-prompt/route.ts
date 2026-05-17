import { withAdminAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';

export const GET = withAdminAuth(async (adminUser, request) => {
  const webUrl = process.env.WEB_APP_INTERNAL_URL ?? process.env.NEXT_PUBLIC_WEB_APP_URL;
  const serviceSecret = process.env.SERVICE_API_SECRET;

  if (!webUrl || !serviceSecret) {
    loggers.auth.warn('Global prompt proxy not configured: WEB_APP_INTERNAL_URL or SERVICE_API_SECRET missing');
    return Response.json(
      { error: 'Global prompt proxy is not configured on this host. Set WEB_APP_INTERNAL_URL and SERVICE_API_SECRET.' },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const target = new URL('/api/admin/global-prompt', webUrl);
  for (const [key, value] of searchParams) {
    target.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        'x-service-secret': serviceSecret,
        'x-service-user-id': adminUser.id,
      },
    });
    const body = await upstream.json();
    return Response.json(body, { status: upstream.status });
  } catch (err) {
    loggers.auth.error('Global prompt proxy error', err as Error);
    return Response.json({ error: 'Failed to reach web app.' }, { status: 502 });
  }
});
