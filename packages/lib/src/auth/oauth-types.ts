/**
 * OAuth Provider Types and Interfaces for Mobile Authentication
 *
 * This module defines shared types for OAuth authentication across
 * different providers (Google, Apple, GitHub, etc.)
 */

/**
 * Supported OAuth providers
 */
export enum OAuthProvider {
  GOOGLE = 'google',
  APPLE = 'apple',
  GITHUB = 'github',
}

/**
 * OAuth user information extracted from provider
 */
export interface OAuthUserInfo {
  /** Provider's unique user ID (e.g., Google's 'sub' claim) */
  providerId: string;
  /** User's email address */
  email: string;
  /** Whether email is verified by provider */
  emailVerified: boolean;
  /** User's display name */
  name?: string;
  /** User's profile picture URL */
  picture?: string;
  /** OAuth provider */
  provider: OAuthProvider;
}

/**
 * Request body for mobile OAuth token exchange
 */
export interface MobileOAuthRequest {
  /** ID token from native OAuth SDK (Google, Apple, etc.) */
  idToken: string;
  /** Optional state parameter for additional context */
  state?: string;
}

/**
 * Response from mobile OAuth authentication
 */
export interface MobileOAuthResponse {
  /** Authenticated user object */
  user: {
    id: string;
    email: string;
    name: string;
    picture: string | null;
    provider: 'email' | 'google' | 'apple' | 'both';
    role: 'user' | 'admin';
    emailVerified: Date | null;
  };
  /** Opaque session token (ps_sess_*) for authentication */
  sessionToken: string;
  /** CSRF token for additional security */
  csrfToken: string;
  /** Device token for 90-day persistent authentication */
  deviceToken: string;
}

/**
 * OAuth verification result
 */
export interface OAuthVerificationResult {
  /** Whether verification succeeded */
  success: boolean;
  /** Extracted user info if successful */
  userInfo?: OAuthUserInfo;
  /** Error message if verification failed */
  error?: string;
}
