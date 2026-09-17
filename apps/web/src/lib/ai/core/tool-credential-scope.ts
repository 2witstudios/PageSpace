import { getAllowedDriveIds, type AuthResult } from '@/lib/auth';
import { getCredentialCeiling } from '@/lib/auth/credential-ceiling';
import type { ToolExecutionContext } from './types';

/**
 * The part of a `ToolExecutionContext` that binds tool execution to the
 * request's CREDENTIAL — its drive scope and its role ceiling — so an agent's
 * broader ACL can never carry a scoped credential past either.
 *
 * Built in exactly one place from an `AuthResult`, and spread into every
 * context an entry point constructs: a context that forgets a field here is a
 * context that runs with the owning user's full reach. The ceiling is the same
 * principal-neutral value the request's own permission helpers resolve through
 * (`getCredentialCeiling`), so a drive-scoped `mcp_` key and an OAuth grant
 * with the same drive and role are capped identically in both places.
 */
export function toolCredentialScope(
  auth: AuthResult,
): Pick<ToolExecutionContext, 'mcpAllowedDriveIds' | 'credentialCeiling'> {
  return {
    mcpAllowedDriveIds: getAllowedDriveIds(auth),
    credentialCeiling: getCredentialCeiling(auth),
  };
}
