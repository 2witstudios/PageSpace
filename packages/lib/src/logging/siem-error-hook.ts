import { createHmac } from 'crypto';

export interface SiemErrorPayload {
  timestamp: string;
  level: string;
  message: string;
  hostname: string;
  pid: number;
  category?: string;
  error?: { name: string; message: string; stack?: string };
  metadata?: Record<string, unknown>;
}

export type SiemErrorHookFn = (payload: SiemErrorPayload) => void;

let hookFn: SiemErrorHookFn | null = null;

export function setSiemErrorHook(fn: SiemErrorHookFn | null): void {
  hookFn = fn;
}

export function getSiemErrorHook(): SiemErrorHookFn | null {
  return hookFn;
}

export function fireSiemErrorHook(payload: SiemErrorPayload): void {
  if (!hookFn) return;
  try {
    hookFn(payload);
  } catch {
    // Hook failures must never interrupt the logging path.
  }
}

export function buildWebhookSiemErrorHook(webhookUrl: string, secret: string): SiemErrorHookFn {
  return (payload: SiemErrorPayload) => {
    const body = JSON.stringify({
      version: '1.0',
      source: 'pagespace-error',
      ...payload,
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PageSpace-Signature': signature,
        'X-PageSpace-Timestamp': new Date().toISOString(),
      },
      body,
    }).catch(() => {
      // Delivery failure must never break the logging path.
    });
  };
}
