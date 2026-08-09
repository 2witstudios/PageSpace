import { createHmac, randomUUID } from 'crypto'
import type { BackupFailureAlert } from './backup-service'

export interface AlertPublishConfig {
  /** apps/web's base URL, e.g. https://pagespace.ai */
  webBaseUrl: string
  /** Shared secret with apps/web's signed-request verifier (CRON_SECRET) — see the internal alert-intake route's docblock for why this reuses the cron auth scheme instead of a parallel one. */
  sharedSecret: string
  fetchImpl?: typeof fetch
}

const ALERT_INTAKE_PATH = '/api/internal/alerts/publish'

/**
 * Signs a request the same way apps/web's cron-auth verifier expects:
 * HMAC-SHA256(secret, `${timestamp}:${nonce}:${method}:${path}`). Duplicated
 * here (rather than imported) because apps/web's cron-auth module lives
 * inside apps/web, not packages/lib — apps in this monorepo don't import
 * each other's source, only shared packages. Keep this message format in
 * sync with apps/web/src/lib/auth/cron-auth.ts's computeCronSignature.
 */
function signInternalRequest(secret: string, method: string, path: string): { timestamp: string; nonce: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomUUID()
  const signature = createHmac('sha256', secret).update(`${timestamp}:${nonce}:${method}:${path}`).digest('hex')
  return { timestamp, nonce, signature }
}

/**
 * Publishes a tenant-backup-failure alert to apps/web's channel-alert
 * subscriptions via its signed internal intake endpoint — control-plane has
 * its own database, separate from the main app's, so it cannot call
 * publishAlert() as a direct service import the way apps/web's own producers
 * (the logger hook, cron routes) do. Best-effort: swallows its own failures
 * so a notification problem never surfaces as a backup failure.
 */
export function createHttpAlertPublisher(config: AlertPublishConfig): (alert: BackupFailureAlert) => Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch

  return async (alert: BackupFailureAlert): Promise<void> => {
    const { timestamp, nonce, signature } = signInternalRequest(config.sharedSecret, 'POST', ALERT_INTAKE_PATH)

    try {
      await fetchImpl(`${config.webBaseUrl}${ALERT_INTAKE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cron-timestamp': timestamp,
          'x-cron-nonce': nonce,
          'x-cron-signature': signature,
        },
        body: JSON.stringify({
          sourceType: 'backup_failure',
          severity: 'error',
          source: alert.slug,
          title: `Backup failed for tenant ${alert.slug}`,
          message: alert.errorMessage,
          dedupeKey: `backup_failure:${alert.tenantId}:${alert.errorMessage}`,
          filter: { tenant: alert.slug },
        }),
      })
    } catch {
      // Best-effort — see docstring.
    }
  }
}
