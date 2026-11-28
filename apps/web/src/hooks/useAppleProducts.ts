'use client';

import useSWR from 'swr';
import { appleCreditPacks, appleProProduct, type AppleStoreProduct } from '@/lib/iap/apple-store-core';

/** SWR key for the StoreKit product list (not a URL: the fetcher is the native plugin). */
export const APPLE_PRODUCTS_SWR_KEY = 'iap:apple:products';

async function fetchAppleProducts(): Promise<AppleStoreProduct[]> {
  const { loadAppleProducts } = await import('@/lib/iap/apple-store');
  return loadAppleProducts();
}

/**
 * The App Store products this storefront sells, with StoreKit's localized
 * prices. Pass `enabled` only on the `'apple'` billing channel — anywhere else
 * the plugin does not exist and nothing is fetched.
 */
export function useAppleProducts(enabled: boolean) {
  const { data, error, isLoading } = useSWR<AppleStoreProduct[]>(
    enabled ? APPLE_PRODUCTS_SWR_KEY : null,
    fetchAppleProducts,
    { revalidateOnFocus: false, revalidateIfStale: false, dedupingInterval: 10 * 60 * 1000 },
  );
  const products = data ?? [];
  return {
    products,
    pro: appleProProduct(products),
    creditPacks: appleCreditPacks(products),
    isLoading: enabled && isLoading,
    isError: !!error,
  };
}
