import { sql, type SQL } from '@pagespace/db/operators';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';

/**
 * The canonical page-visibility set as a FROM-able SQL fragment, for every query that reads it
 * (accessiblePageIds, page payloads, breadcrumbs). The org rules (org Owner/Admin power, implicit
 * Open-drive membership with the POL-6 floor, stale org rows counting for nothing) switch on with
 * ORGS_ENABLED, exactly as they do in getUserAccessLevel; dark, the function is the pre-org decision.
 *
 * A userId-only resolver: it knows nothing of the caller's credential, so it is NOT a package export
 * (D-OW-45). Lib readers reach it only behind the actor's org sign-in check (accessiblePageIds,
 * loadPagePayload).
 */
export function accessiblePageIdsSource(userId: string): SQL {
  return sql`accessible_page_ids_for_user(${userId}, ${ORGS_ENABLED})`;
}
