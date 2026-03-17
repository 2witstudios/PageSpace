export type StripeClient = {
  products: {
    list: (params: Record<string, unknown>) => Promise<{ data: Array<{ id: string; metadata: Record<string, string> }> }>
    create: (params: Record<string, unknown>) => Promise<{ id: string }>
  }
  prices: {
    list: (params: Record<string, unknown>) => Promise<{ data: Array<{ id: string; metadata: Record<string, string> }> }>
    create: (params: Record<string, unknown>) => Promise<{ id: string }>
  }
}

type PriceTier = {
  tier: string
  amount: number
  nickname: string
}

const PRODUCT_NAME = 'PageSpace Isolated Infrastructure'
const PRODUCT_METADATA = { product_type: 'tenant_infrastructure' }

const PRICE_TIERS: PriceTier[] = [
  { tier: 'standard', amount: 19900, nickname: 'Standard ($199/mo)' },
  { tier: 'enterprise', amount: 49900, nickname: 'Enterprise ($499/mo)' },
]

type SetupResult = {
  productId: string
  prices: Array<{ id: string; tier: string }>
}

export async function setupStripeProducts(stripe: StripeClient): Promise<SetupResult> {
  // Idempotent product creation
  const existingProducts = await stripe.products.list({
    limit: 100,
  })

  let productId: string

  const existingProduct = existingProducts.data.find(
    (p) => p.metadata.product_type === 'tenant_infrastructure'
  )

  if (existingProduct) {
    productId = existingProduct.id
  } else {
    const product = await stripe.products.create({
      name: PRODUCT_NAME,
      metadata: PRODUCT_METADATA,
    })
    productId = product.id
  }

  // Idempotent price creation
  const existingPrices = await stripe.prices.list({
    product: productId,
    limit: 100,
  })

  const existingTiers = new Set(
    existingPrices.data.map((p) => p.metadata.tier)
  )

  const prices: Array<{ id: string; tier: string }> = existingPrices.data.map((p) => ({
    id: p.id,
    tier: p.metadata.tier,
  }))

  for (const tierConfig of PRICE_TIERS) {
    if (existingTiers.has(tierConfig.tier)) continue

    const price = await stripe.prices.create({
      product: productId,
      unit_amount: tierConfig.amount,
      currency: 'usd',
      recurring: { interval: 'month' },
      nickname: tierConfig.nickname,
      metadata: { tier: tierConfig.tier },
    })
    prices.push({ id: price.id, tier: tierConfig.tier })
  }

  return { productId, prices }
}
