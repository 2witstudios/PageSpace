/**
 * Which of the subject's org content an Art 15 export may carry to the credential requesting it (SEC-2/3, D-OW-62).
 *
 * A subject access request answered through the person's own session is a read like any other: content of an org drive
 * whose sign-in policy refuses that credential, and digests DERIVED from such drives (Pulse summaries, memory
 * candidates, distilled memory and the memory pages restating it), are left out of the bundle, and the manifest names
 * what was left out and the code that unlocks it, so the person can sign in again (or with a passkey) and re-export.
 * Nothing is deleted or hidden from the record: the same export, requested through a satisfying credential, carries it.
 *
 * The operator fulfilling a verified request on the subject's behalf (the admin console) presents no subject credential;
 * the org sign-in policy governs how a PERSON signs in, so the operator's bundle is complete (OPERATOR_EXPORT_GATE).
 */
import type { AccessActor, OrgAuthenticationDenialCode } from '../../permissions/access-actor';
import { checkActorDriveAuthentication } from '../../permissions/actor-authentication';
import {
  checkDerivedContentAccess,
  refusedDerivedPages,
  type DerivedContentAccess,
  type DerivedContentRefusal,
} from '../../permissions/org-derived-content';

export interface ExportSignInGate {
  /** May the export carry content derived from these orgs' drives? Empty: always. */
  derivedContent(orgIds: readonly string[]): Promise<DerivedContentAccess>;
  /** The drives (of `driveIds`) whose content the export may not carry, each with the code that unlocks it. */
  refusedDrives(driveIds: readonly string[]): Promise<Map<string, OrgAuthenticationDenialCode>>;
  /** The pages (of `pageIds`) restating org-derived content (memory pages) the export may not carry. */
  refusedDerivedPages(pageIds: readonly string[]): Promise<Map<string, DerivedContentRefusal>>;
}

/** The export requested through the subject's own credential: carries only what that credential may read. */
export function credentialExportGate(actor: AccessActor): ExportSignInGate {
  return {
    derivedContent: (orgIds) => checkDerivedContentAccess(actor, orgIds),
    refusedDrives: async (driveIds) => {
      const refused = new Map<string, OrgAuthenticationDenialCode>();
      for (const driveId of new Set(driveIds)) {
        const decision = await checkActorDriveAuthentication(actor, driveId);
        if (!decision.allowed && decision.code !== 'automation_out_of_scope') refused.set(driveId, decision.code);
      }
      return refused;
    },
    refusedDerivedPages: (pageIds) => refusedDerivedPages(actor, pageIds),
  };
}

/**
 * The operator fulfilling a verified request on the subject's behalf: no subject credential is presented, and an org's
 * sign-in policy governs how a person signs in, not the controller's own disclosure duty, so nothing is withheld.
 */
export const OPERATOR_EXPORT_GATE: ExportSignInGate = {
  derivedContent: async () => ({ allowed: true }),
  refusedDrives: async () => new Map(),
  refusedDerivedPages: async () => new Map(),
};
