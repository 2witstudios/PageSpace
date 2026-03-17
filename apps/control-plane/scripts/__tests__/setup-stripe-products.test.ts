import { describe, test, expect, vi, beforeEach } from 'vitest'
import { setupStripeProducts, type StripeClient } from '../setup-stripe-products'

function makeStripeClient(overrides: Partial<StripeClient> = {}): StripeClient {
  return {
    products: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ id: 'prod_new', name: 'PageSpace Isolated Infrastructure' }),
    },
    prices: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ id: 'price_new', unit_amount: 19900 }),
    },
    ...overrides,
  }
}

describe('setupStripeProducts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('given no existing product, should create product with correct metadata', async () => {
    const stripe = makeStripeClient()

    await setupStripeProducts(stripe)

    expect(stripe.products.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'PageSpace Isolated Infrastructure',
        metadata: expect.objectContaining({ product_type: 'tenant_infrastructure' }),
      })
    )
  })

  test('given existing product with matching metadata, should skip creation', async () => {
    const existingProduct = {
      id: 'prod_existing',
      name: 'PageSpace Isolated Infrastructure',
      metadata: { product_type: 'tenant_infrastructure' },
    }
    const stripe = makeStripeClient({
      products: {
        list: vi.fn().mockResolvedValue({ data: [existingProduct] }),
        create: vi.fn(),
      },
    })

    await setupStripeProducts(stripe)

    expect(stripe.products.create).not.toHaveBeenCalled()
  })

  test('given no existing prices, should create standard and enterprise prices', async () => {
    const stripe = makeStripeClient()
    stripe.prices.create = vi.fn().mockResolvedValue({ id: 'price_new' })

    await setupStripeProducts(stripe)

    expect(stripe.prices.create).toHaveBeenCalledTimes(2)

    const calls = (stripe.prices.create as ReturnType<typeof vi.fn>).mock.calls
    const standardCall = calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).unit_amount === 19900
    )
    const enterpriseCall = calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).unit_amount === 49900
    )

    expect(standardCall).toBeDefined()
    expect(standardCall![0]).toMatchObject({
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: expect.objectContaining({ tier: 'standard' }),
    })

    expect(enterpriseCall).toBeDefined()
    expect(enterpriseCall![0]).toMatchObject({
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: expect.objectContaining({ tier: 'enterprise' }),
    })
  })

  test('given existing price for standard tier, should skip that tier and create only enterprise', async () => {
    const existingPrice = {
      id: 'price_existing',
      unit_amount: 19900,
      metadata: { tier: 'standard' },
    }
    const stripe = makeStripeClient()
    stripe.prices.list = vi.fn().mockResolvedValue({ data: [existingPrice] })
    stripe.prices.create = vi.fn().mockResolvedValue({ id: 'price_new' })

    await setupStripeProducts(stripe)

    expect(stripe.prices.create).toHaveBeenCalledTimes(1)
    const call = (stripe.prices.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.metadata.tier).toBe('enterprise')
  })

  test('given all prices exist, should skip all price creation', async () => {
    const existingPrices = [
      { id: 'price_std', unit_amount: 19900, metadata: { tier: 'standard' } },
      { id: 'price_ent', unit_amount: 49900, metadata: { tier: 'enterprise' } },
    ]
    const stripe = makeStripeClient()
    stripe.prices.list = vi.fn().mockResolvedValue({ data: existingPrices })
    stripe.prices.create = vi.fn()

    await setupStripeProducts(stripe)

    expect(stripe.prices.create).not.toHaveBeenCalled()
  })

  test('should return product id and price ids', async () => {
    const stripe = makeStripeClient()
    stripe.products.create = vi.fn().mockResolvedValue({ id: 'prod_abc' })
    stripe.prices.create = vi.fn()
      .mockResolvedValueOnce({ id: 'price_std' })
      .mockResolvedValueOnce({ id: 'price_ent' })

    const result = await setupStripeProducts(stripe)

    expect(result.productId).toBe('prod_abc')
    expect(result.prices).toHaveLength(2)
  })
})
