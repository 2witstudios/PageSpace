/**
 * Type definitions for Google Identity Services (GIS) library
 * Used for Google One Tap sign-in
 * @see https://developers.google.com/identity/gsi/web/reference/js-reference
 */

export interface CredentialResponse {
  /** The JWT credential returned from Google */
  credential: string;
  /** How the credential was selected */
  select_by:
    | 'auto'
    | 'user'
    | 'user_1tap'
    | 'user_2tap'
    | 'btn'
    | 'btn_confirm'
    | 'btn_add_session'
    | 'btn_confirm_add_session';
  /** Client ID that was used */
  clientId?: string;
}

export interface GsiButtonConfiguration {
  /** Button type */
  type?: 'standard' | 'icon';
  /** Button theme */
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  /** Button size */
  size?: 'large' | 'medium' | 'small';
  /** Button text */
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  /** Button shape */
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  /** Logo alignment */
  logo_alignment?: 'left' | 'center';
  /** Button width in pixels */
  width?: number;
  /** Locale for button text */
  locale?: string;
  /** Callback when button click starts */
  click_listener?: () => void;
}

export interface IdConfiguration {
  /** Your Google OAuth Client ID */
  client_id: string;
  /** Callback function when credential is returned */
  callback?: (response: CredentialResponse) => void;
  /** URI for automatic sign-in */
  login_uri?: string;
  /** Enable auto-select for returning users */
  auto_select?: boolean;
  /** Nonce for ID token validation */
  nonce?: string;
  /** Cancel One Tap if tapped outside */
  cancel_on_tap_outside?: boolean;
  /** Parent DOM ID for prompt */
  prompt_parent_id?: string;
  /** Context for the sign-in */
  context?: 'signin' | 'signup' | 'use';
  /** State cookie domain */
  state_cookie_domain?: string;
  /** UX mode */
  ux_mode?: 'popup' | 'redirect';
  /** Allowed parent origins for iframe */
  allowed_parent_origin?: string | string[];
  /** Intermediate iframe close callback */
  intermediate_iframe_close_callback?: () => void;
  /** ITP support */
  itp_support?: boolean;
  /** Hosted domain restriction */
  hosted_domain?: string;
  /** Use FedCM for One Tap */
  use_fedcm_for_prompt?: boolean;
}

export interface PromptMomentNotification {
  /** Whether the prompt is displayed */
  isDisplayed: () => boolean;
  /** Whether the prompt is not displayed */
  isNotDisplayed: () => boolean;
  /** Whether the prompt is skipped */
  isSkippedMoment: () => boolean;
  /** Whether the prompt is dismissed */
  isDismissedMoment: () => boolean;
  /** Get the moment type */
  getMomentType: () => 'display' | 'skipped' | 'dismissed';
  /** Get the reason for not displaying */
  getNotDisplayedReason: () =>
    | 'browser_not_supported'
    | 'invalid_client'
    | 'missing_client_id'
    | 'opt_out_or_no_session'
    | 'secure_http_required'
    | 'suppressed_by_user'
    | 'unregistered_origin'
    | 'unknown_reason';
  /** Get the reason for skipping */
  getSkippedReason: () =>
    | 'auto_cancel'
    | 'user_cancel'
    | 'tap_outside'
    | 'issuing_failed';
  /** Get the reason for dismissal */
  getDismissedReason: () =>
    | 'credential_returned'
    | 'cancel_called'
    | 'flow_restarted';
}

export interface GoogleAccountsId {
  /** Initialize Google Identity Services */
  initialize: (config: IdConfiguration) => void;
  /** Display the One Tap prompt */
  prompt: (momentListener?: (notification: PromptMomentNotification) => void) => void;
  /** Render a sign-in button */
  renderButton: (parent: HTMLElement, options: GsiButtonConfiguration) => void;
  /** Disable auto-select */
  disableAutoSelect: () => void;
  /** Store a credential */
  storeCredential: (credential: { id: string; password: string }) => void;
  /** Cancel the One Tap flow */
  cancel: () => void;
  /** Revoke access for a user */
  revoke: (hint: string, callback?: (response: { successful: boolean; error?: string }) => void) => void;
}

export interface GoogleAccounts {
  id: GoogleAccountsId;
}

declare global {
  interface Window {
    google?: {
      accounts: GoogleAccounts;
    };
    __webpack_nonce__?: string;
  }
}

export {};
