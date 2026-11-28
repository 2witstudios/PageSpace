import { hashToken } from '@pagespace/lib/auth/token-utils';

/**
 * The step-up action binding for re-authenticating ONE session (D-OW-45). It names the session by a hash of its id,
 * so a grant earned for this session can never re-authenticate another one, and the id itself never reaches the client.
 */
export const reauthenticationActionBinding = (sessionId: string): Record<string, string> => ({
  action: 'reauthenticate_session',
  session: hashToken(sessionId),
});
