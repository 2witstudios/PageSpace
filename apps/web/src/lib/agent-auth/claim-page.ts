/**
 * The human page an agent's user code is entered on (auth.md "Fund",
 * `verification_uri`). Derived from the same issuer normalisation as the RFC
 * 8414 metadata, so the claim endpoint's answer and `/auth.md` name one URL.
 */
import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

export const AGENT_CLAIM_PAGE_PATH = '/claim';

export function agentClaimPageUrl(issuer: string): string {
  return `${buildServerMetadata({ issuer }).issuer}${AGENT_CLAIM_PAGE_PATH}`;
}
