/**
 * Connecting a Google account to an agent (slice 3; ADR 0005 §5, §10d): what
 * a person picks, as data and as a verdict. Pure.
 *
 * A person picks SERVICES, not scopes. Each service names the narrowest Google
 * scope that does the job and the API origin it is used at; the account is
 * pinned to exactly those origins, so a Gmail-only account can never be sent
 * to Drive. `openid email` are always asked too — they name WHICH Google
 * account was connected (the id token's verified email), and nothing else.
 *
 * "Read without asking" writes a standing policy over the `read` class only:
 * sending mail, deleting and sharing (irreversible / privilege) can never be
 * standing; writes ask until the person allows them in Permissions.
 */
import type { AccountAcknowledgment } from '@pagespace/db/schema/agent-accounts';
import type { AccountApprovalPolicy } from '../approval';
import type { CanonicalOrigin } from '../canonical-request';
import type { UserId } from '../grant';
import type { LoginOwnership } from '../decide-acknowledgment';
import { decideAcknowledgment } from '../decide-acknowledgment';
import { GENERIC_REQUEST_LIMITS, MAX_ACCOUNT_NAME_LENGTH } from '../decide-account-creation';
import { GMAIL_ORIGIN, GOOGLE_APIS_ORIGIN, GOOGLE_PROVIDER_SLUG } from '../registry/google-operations';

export const GOOGLE_SERVICES = {
  'gmail.read': { scope: 'https://www.googleapis.com/auth/gmail.readonly', origin: GMAIL_ORIGIN, label: 'Read Gmail' },
  'gmail.modify': { scope: 'https://www.googleapis.com/auth/gmail.modify', origin: GMAIL_ORIGIN, label: 'Read, draft, label and trash Gmail' },
  'gmail.send': { scope: 'https://www.googleapis.com/auth/gmail.send', origin: GMAIL_ORIGIN, label: 'Send Gmail' },
  'calendar.read': { scope: 'https://www.googleapis.com/auth/calendar.readonly', origin: GOOGLE_APIS_ORIGIN, label: 'Read Calendar' },
  calendar: { scope: 'https://www.googleapis.com/auth/calendar', origin: GOOGLE_APIS_ORIGIN, label: 'Read and change Calendar' },
  'drive.read': { scope: 'https://www.googleapis.com/auth/drive.readonly', origin: GOOGLE_APIS_ORIGIN, label: 'Read Drive' },
  drive: { scope: 'https://www.googleapis.com/auth/drive', origin: GOOGLE_APIS_ORIGIN, label: 'Read and change Drive' },
} as const satisfies Readonly<Record<string, { readonly scope: string; readonly origin: CanonicalOrigin; readonly label: string }>>;

export type GoogleService = keyof typeof GOOGLE_SERVICES;
export const GOOGLE_SERVICE_IDS = Object.keys(GOOGLE_SERVICES) as GoogleService[];
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email'] as const;

export type GoogleEnrollmentInput = {
  readonly name: string;
  readonly services: readonly string[];
  readonly ownership: LoginOwnership;
  readonly acknowledged: boolean;
  /** Exactly `true` = "let the agent read without asking". */
  readonly autoApproveReads: boolean;
};

export type OAuthAccountDraft = {
  readonly kind: 'oauth2';
  readonly providerSlug: typeof GOOGLE_PROVIDER_SLUG;
  readonly name: string;
  readonly allowedOrigins: readonly CanonicalOrigin[];
  readonly acknowledgment: AccountAcknowledgment;
  readonly approvalPolicy: AccountApprovalPolicy | null;
  /** What Google is asked for: identity scopes plus one per service, sorted. */
  readonly requestedScopes: readonly string[];
};

export type GoogleEnrollmentVerdict =
  | { readonly ok: true; readonly draft: OAuthAccountDraft }
  | { readonly ok: false; readonly reason: 'name_invalid' | 'services_empty' | 'service_unknown' | 'acknowledgment_required' };

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

export function decideGoogleEnrollment({ input, approver }: { readonly input: GoogleEnrollmentInput; readonly approver: UserId }): GoogleEnrollmentVerdict {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > MAX_ACCOUNT_NAME_LENGTH || CONTROL_CHAR_RE.test(name)) return { ok: false, reason: 'name_invalid' };
  if (!Array.isArray(input.services) || input.services.length === 0) return { ok: false, reason: 'services_empty' };
  if (!input.services.every((service) => Object.prototype.hasOwnProperty.call(GOOGLE_SERVICES, service))) return { ok: false, reason: 'service_unknown' };
  const services = [...new Set(input.services as GoogleService[])];

  const acknowledgment = decideAcknowledgment({ kind: 'oauth2', ownership: input.ownership, acknowledged: input.acknowledged });
  if (!acknowledgment.ok) return { ok: false, reason: 'acknowledgment_required' };

  const allowedOrigins = [...new Set(services.map((service) => GOOGLE_SERVICES[service].origin))].sort();
  const requestedScopes = [...new Set([...GOOGLE_IDENTITY_SCOPES, ...services.map((service) => GOOGLE_SERVICES[service].scope)])].sort();
  const approvalPolicy: AccountApprovalPolicy | null =
    input.autoApproveReads === true
      ? { scope: { origins: allowedOrigins, operations: [{ class: 'read', name: '*' }], resources: [] }, trigger: 'unknown_and_irreversible', duration: null, limits: { ...GENERIC_REQUEST_LIMITS }, approver }
      : null;
  return { ok: true, draft: { kind: 'oauth2', providerSlug: GOOGLE_PROVIDER_SLUG, name, allowedOrigins, acknowledgment: acknowledgment.acknowledgment, approvalPolicy, requestedScopes } };
}
