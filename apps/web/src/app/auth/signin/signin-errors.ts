/**
 * Copy for the `?error=` and `?onprem=` query params the sign-in page reacts to.
 * Shared by the classic sonner toasts and the v3 status pill so both show the same words.
 */

export interface SigninNotice {
  tone: 'danger' | 'info';
  text: string;
}

export function signinErrorNotice(error: string): SigninNotice {
  switch (error) {
    case 'access_denied':
      return { tone: 'danger', text: 'Google sign-in was cancelled. Please try again if you want to continue.' };
    case 'oauth_error':
      return { tone: 'danger', text: 'Google sign-in failed. Please try again.' };
    case 'rate_limit':
      return { tone: 'danger', text: 'Too many login attempts. Please try again later.' };
    case 'invalid_request':
      return { tone: 'danger', text: 'Invalid request. Please try again.' };
    case 'magic_link_expired':
      return { tone: 'danger', text: 'Your sign-in link has expired. Please request a new one.' };
    case 'magic_link_used':
      return { tone: 'danger', text: 'This sign-in link has already been used. Please request a new one.' };
    case 'account_suspended':
      return { tone: 'danger', text: 'Your account has been suspended. Please contact support.' };
    case 'invalid_token':
      return { tone: 'danger', text: 'Invalid sign-in link. Please request a new one.' };
    default:
      return { tone: 'danger', text: 'An error occurred during sign-in.' };
  }
}

/** The single notice the v3 sign-in card shows at its top, or null when there is none. */
export function signinPillNotice(params: URLSearchParams): SigninNotice | null {
  const error = params.get('error');
  if (error) return signinErrorNotice(error);
  if (params.get('onprem') === 'contact_admin') {
    return { tone: 'info', text: 'Contact your administrator for an account.' };
  }
  return null;
}
