import { after } from 'next/server';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { verifyZoomWebhookSignature, handleUrlValidationChallenge } from '@/lib/integrations/zoom/verify-webhook';
import { processZoomWebhook } from '@/lib/integrations/zoom/process-webhook';

export async function POST(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  if (!process.env.ZOOM_WEBHOOK_SECRET_TOKEN) {
    loggers.api.error('ZOOM_WEBHOOK_SECRET_TOKEN is not configured');
    return Response.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  try {
    const rawBody = await request.text();

    const signature = request.headers.get('x-zm-signature');
    const timestamp = request.headers.get('x-zm-request-timestamp');

    if (!verifyZoomWebhookSignature(signature, timestamp, rawBody, process.env.ZOOM_WEBHOOK_SECRET_TOKEN)) {
      loggers.api.warn('Zoom webhook: invalid signature');
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = JSON.parse(rawBody) as { event?: string; payload?: { plainToken?: string } };

    // URL validation challenge: Zoom sends this to verify ownership of the endpoint.
    // Signature is verified above first — this response is HMAC-authenticated.
    if (body.event === 'endpoint.url_validation') {
      const plainToken = body.payload?.plainToken;
      if (!plainToken) {
        return Response.json({ error: 'Invalid challenge' }, { status: 400 });
      }
      return Response.json(handleUrlValidationChallenge(plainToken, process.env.ZOOM_WEBHOOK_SECRET_TOKEN));
    }

    // Return 200 immediately; process async so Zoom's retry logic sees success
    after(() => {
      processZoomWebhook(body).catch((err) => {
        loggers.api.error('Zoom webhook processing failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    return Response.json({ ok: true });
  } catch (error) {
    loggers.api.error('Zoom webhook error', error as Error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
