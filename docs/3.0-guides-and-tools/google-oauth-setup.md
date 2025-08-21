# Google OAuth Setup Guide

This guide walks you through setting up Google OAuth authentication for your PageSpace application.

## Overview

PageSpace supports Google OAuth alongside traditional email/password authentication. Users can:
- Sign in with Google OAuth
- Link their Google account to an existing email account
- Use both authentication methods (provider: 'both')

## Prerequisites

1. A Google Cloud Platform account
2. PageSpace development environment set up
3. Database migrations applied (includes `googleId` and `provider` fields)

## Step 1: Google Cloud Console Setup

### 1.1 Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Create Project" or select an existing project
3. Note the project ID for reference

### 1.2 Enable Google+ API

1. Navigate to "APIs & Services" > "Library"
2. Search for "Google+ API" or "Google Identity Services"
3. Click "Enable"

### 1.3 Configure OAuth Consent Screen

1. Go to "APIs & Services" > "OAuth consent screen"
2. Choose "External" user type (for development)
3. Fill in required fields:
   - App name: "PageSpace"
   - User support email: Your email
   - Developer contact information: Your email
4. Add scopes:
   - `openid`
   - `email` 
   - `profile`
5. Add test users (your development email addresses)

### 1.4 Create OAuth Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. Choose "Web application"
4. Set application name: "PageSpace Web Client"
5. Add authorized JavaScript origins:
   - `http://localhost:3000` (development)
   - Your production domain (when ready)
6. Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/google/callback` (development)
   - `https://yourdomain.com/api/auth/google/callback` (production)
7. Save and note the Client ID and Client Secret

## Step 2: Environment Configuration

### 2.1 Update Environment Variables

Add the following to your `.env` file:

```env
# Google OAuth Configuration
GOOGLE_OAUTH_CLIENT_ID=your_client_id_here
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_here
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

### 2.2 Production Configuration

For production, update the redirect URI:

```env
GOOGLE_OAUTH_REDIRECT_URI=https://yourdomain.com/api/auth/google/callback
```

## Step 3: Database Schema

The required database changes are already implemented:

- `users.googleId` - Stores Google user ID
- `users.provider` - Tracks authentication method ('email', 'google', 'both')
- `AuthProvider` enum - Defines available provider types

## Step 4: API Endpoints

The following API endpoints are implemented:

### 4.1 Initiate OAuth Flow
- **Endpoint**: `POST /api/auth/google/signin`
- **Purpose**: Generates Google OAuth URL and redirects user
- **Alternative**: `GET /api/auth/google/signin` for direct link access

### 4.2 OAuth Callback
- **Endpoint**: `GET /api/auth/google/callback`
- **Purpose**: Handles OAuth callback, verifies token, creates/links user
- **Redirects**: 
  - Success: `/dashboard`
  - Error: `/auth/signin?error=oauth_error`

## Step 5: Frontend Integration

### 5.1 Sign-In Page

The sign-in page includes:
- Traditional email/password form
- "Continue with Google" button
- Error handling for OAuth failures
- Loading states for both authentication methods

### 5.2 Sign-Up Page

The sign-up page includes:
- Traditional account creation form
- "Continue with Google" button for account creation

## Step 6: User Flow

### 6.1 New Google User
1. User clicks "Continue with Google"
2. Redirected to Google OAuth consent screen
3. User grants permissions
4. PageSpace creates new user account with Google data
5. User is logged in and redirected to dashboard

### 6.2 Existing Email User
1. Existing user signs in with Google using same email
2. PageSpace links Google account to existing user
3. User's provider is updated to 'both'
4. User can now use either authentication method

### 6.3 Error Handling
- OAuth errors redirect to sign-in page with error message
- Rate limiting applies to OAuth attempts
- Network errors show appropriate user feedback

## Step 7: Security Features

### 7.1 Token Verification
- Server-side verification of Google ID tokens
- Validates token audience matches client ID
- Extracts verified user information

### 7.2 Rate Limiting
- Same rate limiting rules apply to OAuth attempts
- IP-based rate limiting for OAuth endpoints

### 7.3 Account Linking
- Safe linking of Google accounts to existing email accounts
- Prevents account takeover by verifying email matches

## Step 8: Testing

### 8.1 Development Testing
1. Ensure environment variables are set
2. Start development server: `pnpm dev`
3. Navigate to `/auth/signin`
4. Click "Continue with Google"
5. Complete OAuth flow
6. Verify successful login and dashboard access

### 8.2 Account Linking Testing
1. Create account with email/password
2. Sign out
3. Use "Continue with Google" with same email
4. Verify account is linked (provider becomes 'both')
5. Test signing in with both methods

## Step 9: Production Deployment

### 9.1 Update Google Cloud Console
1. Add production domain to authorized origins
2. Add production callback URL to authorized redirect URIs
3. Update OAuth consent screen for production use

### 9.2 Environment Variables
1. Update `GOOGLE_OAUTH_REDIRECT_URI` for production
2. Ensure all OAuth environment variables are set in production

## Troubleshooting

### Common Issues

1. **"redirect_uri_mismatch" error**
   - Verify redirect URI in Google Cloud Console matches exactly
   - Check for http vs https mismatch
   - Ensure no trailing slashes

2. **"invalid_client" error**
   - Verify client ID and secret are correct
   - Check environment variables are loaded properly

3. **Rate limiting errors**
   - Users see rate limit message
   - Check rate limiting configuration
   - Verify IP detection is working

4. **Email verification issues**
   - Google provides `email_verified` status
   - PageSpace updates `emailVerified` field accordingly

### Debug Tips

1. Check server logs for OAuth errors
2. Verify Google Cloud Console configuration
3. Test with different Google accounts
4. Check network requests in browser dev tools

## Security Considerations

1. **Never expose client secret** in frontend code
2. **Always verify tokens server-side** using Google's library
3. **Use HTTPS in production** for OAuth redirects
4. **Implement proper CSRF protection** (already included)
5. **Rate limit OAuth endpoints** (already implemented)

## Integration with Existing Auth System

The Google OAuth implementation seamlessly integrates with PageSpace's existing authentication:

- **JWT tokens**: Same JWT generation and refresh logic
- **Session management**: Uses existing cookie-based sessions
- **Permissions**: Works with existing role-based access control
- **Multi-service**: Compatible with realtime service authentication
- **Rate limiting**: Uses existing rate limiting infrastructure

This maintains consistency across all authentication methods while adding the convenience of Google OAuth.