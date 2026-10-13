/** How the site expects the key: a bearer header, a bare header, a named header, or a query parameter. */
export type AccountPlacement = 'bearer' | 'authorization' | 'header' | 'query';

/** Whose account it is: a dedicated account for the agent, or a personal login the owner shares with it. */
export type AccountOwnership = 'dedicated' | 'personal';

/** The fields the add form holds, which decide whether it can be submitted. */
export interface AccountDraft {
  readonly name: string;
  readonly origin: string;
  readonly apiKey: string;
  readonly placement: AccountPlacement;
  readonly placementName: string;
  readonly ownership: AccountOwnership;
  readonly acknowledged: boolean;
  readonly submitting: boolean;
}

/** The server's refusal reasons, as the copy the owner reads. */
export const REFUSAL_COPY: Readonly<Record<string, string>> = {
  acknowledgment_required: 'Confirm that this is a personal login you share with your agent.',
  origin_invalid: 'The site address must be an https:// address with no path, like https://api.example.com.',
  origins_empty: 'Enter the site address the key is for.',
  placement_invalid: 'That header or parameter name cannot carry the key.',
  key_invalid: 'The key looks empty or contains line breaks.',
  name_invalid: 'Give the account a name (up to 100 characters).',
  forbidden: 'Only a drive owner or admin can add an account to this agent.',
  not_configured: 'Agent accounts are not set up on this PageSpace deployment.',
  plane_unavailable: 'The credential service is unavailable. Try again later.',
};

/** Whether the placement needs a header or parameter name typed beside it. */
export const placementNeedsName = (placement: AccountPlacement): boolean => placement === 'header' || placement === 'query';

/** The add form's submit gate: every field the chosen placement and ownership require, and not already submitting. */
export function canSubmitAccount(draft: AccountDraft): boolean {
  return (
    draft.name.trim() !== '' &&
    draft.origin.trim() !== '' &&
    draft.apiKey !== '' &&
    (!placementNeedsName(draft.placement) || draft.placementName.trim() !== '') &&
    (draft.ownership === 'dedicated' || draft.acknowledged) &&
    !draft.submitting
  );
}

/** The request body the add form posts; a personal login carries its acknowledgment, a dedicated one never does. */
export function accountRequestBody(draft: AccountDraft & { readonly allowGenericRequests: boolean }) {
  return {
    name: draft.name.trim(),
    allowedOrigins: [draft.origin.trim()],
    ownership: draft.ownership,
    acknowledged: draft.ownership === 'personal' && draft.acknowledged,
    apiKey: draft.placement === 'bearer' ? `Bearer ${draft.apiKey}` : draft.apiKey,
    placement:
      draft.placement === 'query'
        ? { in: 'query' as const, name: draft.placementName.trim() }
        : { in: 'header' as const, name: draft.placement === 'header' ? draft.placementName.trim() : 'Authorization' },
    allowGenericRequests: draft.allowGenericRequests,
  };
}

/** The owner-facing copy for a failed add, read from the refusal reason in the error message. */
export function refusalCopyFor(error: unknown): string {
  const reason = error instanceof Error ? (/"error":"([a-z_]+)"/.exec(error.message)?.[1] ?? '') : '';
  return REFUSAL_COPY[reason] ?? 'The account could not be added.';
}
