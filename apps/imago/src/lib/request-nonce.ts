import 'server-only';
import { headers } from 'next/headers';
import { NONCE_HEADER } from '@/middleware/security-headers';

/**
 * Read the per-request CSP nonce (minted by middleware, applied to script-src)
 * from the incoming request headers. Server Component only.
 */
export async function getRequestNonce(): Promise<string | undefined> {
  const requestHeaders = await headers();
  return requestHeaders.get(NONCE_HEADER) ?? undefined;
}
