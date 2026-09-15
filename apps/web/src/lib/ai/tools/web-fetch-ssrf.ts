/**
 * Pure SSRF-guard decision functions for the `web_fetch` AI tool.
 *
 * The implementation lives in `@pagespace/lib/security/web-fetch-ssrf` so the
 * integration executor (packages/lib) shares the exact same "is this address
 * public?" decision. This module keeps the historical import path for the
 * web app's callers.
 */
export {
  isPublicIp,
  isAllowedFetchTarget,
  isIpLiteral,
  PRIVATE_HOST_MESSAGE,
} from '@pagespace/lib/security/web-fetch-ssrf';
