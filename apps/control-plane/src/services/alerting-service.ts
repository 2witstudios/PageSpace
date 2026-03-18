export type AlertTransport = {
  send(payload: AlertPayload | RecoveryPayload): Promise<void>
}

export type AlertPayload = {
  type: 'alert'
  tenantSlug: string
  status: string
  consecutiveFailures: number
  lastError?: string
  timestamp: Date
}

export type RecoveryPayload = {
  type: 'recovery'
  tenantSlug: string
  status: string
  downtimeDurationMs: number
  timestamp: Date
}

export type AlertingDeps = {
  transports: AlertTransport[]
  deduplicationWindowMs?: number
}

export function createAlertingService(deps: AlertingDeps) {
  const { transports, deduplicationWindowMs = 60 * 60 * 1000 } = deps
  const lastAlertTime = new Map<string, number>()

  async function broadcast(payload: AlertPayload | RecoveryPayload): Promise<void> {
    for (const transport of transports) {
      try {
        await transport.send(payload)
      } catch {
        // Best-effort delivery — continue to other transports
      }
    }
  }

  return {
    async sendAlert(input: {
      tenantSlug: string
      status: string
      consecutiveFailures: number
      lastError?: string
    }): Promise<void> {
      const now = Date.now()
      const lastSent = lastAlertTime.get(input.tenantSlug)

      if (lastSent !== undefined && now - lastSent < deduplicationWindowMs) {
        return
      }

      lastAlertTime.set(input.tenantSlug, now)

      await broadcast({
        type: 'alert',
        tenantSlug: input.tenantSlug,
        status: input.status,
        consecutiveFailures: input.consecutiveFailures,
        lastError: input.lastError,
        timestamp: new Date(now),
      })
    },

    async sendRecovery(input: {
      tenantSlug: string
      status: string
      downtimeDurationMs: number
    }): Promise<void> {
      lastAlertTime.delete(input.tenantSlug)

      await broadcast({
        type: 'recovery',
        tenantSlug: input.tenantSlug,
        status: input.status,
        downtimeDurationMs: input.downtimeDurationMs,
        timestamp: new Date(),
      })
    },
  }
}
