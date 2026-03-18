import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAlertingService, type AlertingDeps } from '../alerting-service'

function makeMockTransport() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDeps(overrides: Partial<AlertingDeps> = {}): AlertingDeps {
  return {
    transports: [makeMockTransport()],
    deduplicationWindowMs: 60 * 60 * 1000, // 1 hour
    ...overrides,
  }
}

describe('AlertingService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T10:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('sendAlert', () => {
    test('given unhealthy tenant alert, should call configured transport with alert payload', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
        lastError: 'connection timeout',
      })

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantSlug: 'acme',
          status: 'unhealthy',
          consecutiveFailures: 3,
          lastError: 'connection timeout',
        })
      )
    })

    test('given multiple transports, should send to all of them', async () => {
      const transport1 = makeMockTransport()
      const transport2 = makeMockTransport()
      const deps = makeDeps({ transports: [transport1, transport2] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      expect(transport1.send).toHaveBeenCalledTimes(1)
      expect(transport2.send).toHaveBeenCalledTimes(1)
    })

    test('given alert payload, should include timestamp', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(Date),
        })
      )
    })
  })

  describe('deduplication', () => {
    test('given same tenant still unhealthy within 1 hour, should NOT send duplicate alert', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      // 30 minutes later
      vi.advanceTimersByTime(30 * 60 * 1000)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 6,
      })

      expect(transport.send).toHaveBeenCalledTimes(1)
    })

    test('given same tenant still unhealthy after 1 hour, should re-alert', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      // 61 minutes later
      vi.advanceTimersByTime(61 * 60 * 1000)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 15,
      })

      expect(transport.send).toHaveBeenCalledTimes(2)
    })

    test('given different tenants, should alert for each independently', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      await service.sendAlert({
        tenantSlug: 'beta-corp',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      expect(transport.send).toHaveBeenCalledTimes(2)
    })
  })

  describe('sendRecovery', () => {
    test('given tenant recovers, should send recovery notification', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      await service.sendRecovery({
        tenantSlug: 'acme',
        status: 'healthy',
        downtimeDurationMs: 15 * 60 * 1000,
      })

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'recovery',
          tenantSlug: 'acme',
          status: 'healthy',
          downtimeDurationMs: 15 * 60 * 1000,
        })
      )
    })

    test('given recovery, should clear deduplication state for that tenant', async () => {
      const transport = makeMockTransport()
      const deps = makeDeps({ transports: [transport] })
      const service = createAlertingService(deps)

      // Send alert
      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      // Recover
      await service.sendRecovery({
        tenantSlug: 'acme',
        status: 'healthy',
        downtimeDurationMs: 5000,
      })

      // New alert should go through immediately (no dedup)
      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      // alert + recovery + alert = 3 sends
      expect(transport.send).toHaveBeenCalledTimes(3)
    })
  })

  describe('transport failure handling', () => {
    test('given transport failure, should not throw and continue to other transports', async () => {
      const failingTransport = { send: vi.fn().mockRejectedValue(new Error('SMTP error')) }
      const workingTransport = makeMockTransport()
      const deps = makeDeps({ transports: [failingTransport, workingTransport] })
      const service = createAlertingService(deps)

      await service.sendAlert({
        tenantSlug: 'acme',
        status: 'unhealthy',
        consecutiveFailures: 3,
      })

      expect(workingTransport.send).toHaveBeenCalledTimes(1)
    })
  })
})
