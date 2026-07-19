import { describe, test, expect, vi } from 'vitest'
import { createHmac } from 'crypto'
import { createHttpAlertPublisher } from '../alert-publish-client'

const CONFIG = { webBaseUrl: 'https://internal.example.com', sharedSecret: 'test-secret' }
const ALERT = { tenantId: 'tenant-1', slug: 'acme', errorMessage: 'connection refused' }

function makeMockFetch(response: Partial<Response> = { ok: true }) {
  return vi.fn().mockResolvedValue(response)
}

describe('createHttpAlertPublisher', () => {
  test('posts to the internal alert-intake path with a valid HMAC signature', async () => {
    const fetchImpl = makeMockFetch()
    const publish = createHttpAlertPublisher({ ...CONFIG, fetchImpl })

    await publish(ALERT)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://internal.example.com/api/internal/alerts/publish')
    expect(opts.method).toBe('POST')

    const timestamp = opts.headers['x-cron-timestamp']
    const nonce = opts.headers['x-cron-nonce']
    const signature = opts.headers['x-cron-signature']
    const expected = createHmac('sha256', CONFIG.sharedSecret)
      .update(`${timestamp}:${nonce}:POST:/api/internal/alerts/publish`)
      .digest('hex')
    expect(signature).toBe(expected)
  })

  test('sends sourceType=backup_failure with a dedupeKey derived from tenantId and error message', async () => {
    const fetchImpl = makeMockFetch()
    const publish = createHttpAlertPublisher({ ...CONFIG, fetchImpl })

    await publish(ALERT)

    const [, opts] = fetchImpl.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.sourceType).toBe('backup_failure')
    expect(body.severity).toBe('error')
    expect(body.message).toBe('connection refused')
    expect(body.dedupeKey).toBe('backup_failure:tenant-1:connection refused')
  })

  test('never throws when the fetch itself rejects (best-effort)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const publish = createHttpAlertPublisher({ ...CONFIG, fetchImpl })

    await expect(publish(ALERT)).resolves.toBeUndefined()
  })

  test('never throws when the endpoint returns a non-2xx status', async () => {
    const fetchImpl = makeMockFetch({ ok: false, status: 500 } as Partial<Response>)
    const publish = createHttpAlertPublisher({ ...CONFIG, fetchImpl })

    await expect(publish(ALERT)).resolves.toBeUndefined()
  })

  test('generates a fresh nonce per call, so two alerts never collide on replay protection', async () => {
    const fetchImpl = makeMockFetch()
    const publish = createHttpAlertPublisher({ ...CONFIG, fetchImpl })

    await publish(ALERT)
    await publish(ALERT)

    const [, firstOpts] = fetchImpl.mock.calls[0]
    const [, secondOpts] = fetchImpl.mock.calls[1]
    expect(firstOpts.headers['x-cron-nonce']).not.toBe(secondOpts.headers['x-cron-nonce'])
  })
})
