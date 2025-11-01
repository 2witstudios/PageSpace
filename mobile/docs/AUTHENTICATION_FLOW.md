# PageSpace Mobile Authentication Flow

This document describes the complete authentication flow for the PageSpace Swift mobile app.

---

## Overview

PageSpace uses **JWT (JSON Web Token)** authentication with CSRF protection for write operations. Tokens are stored securely in iOS Keychain and included in all authenticated requests.

---

## Authentication Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│             │  Login  │              │  Query  │             │
│  Swift App  │────────▶│  Next.js API │────────▶│  PostgreSQL │
│             │         │              │         │             │
└─────────────┘         └──────────────┘         └─────────────┘
      │                        │
      │  JWT + CSRF Token      │
      │◀───────────────────────│
      │                        │
      │  Store in Keychain     │
      ▼                        │
┌─────────────┐                │
│   Keychain  │                │
│  (Secure)   │                │
└─────────────┘                │
      │                        │
      │  Authenticated Request │
      │────────────────────────▶
      │  Authorization: Bearer {token}
      │  X-CSRF-Token: {csrf}
```

---

## Step-by-Step Flow

### 1. User Login

**User Action**: Enters email and password in `LoginView`

**App Flow**:
```swift
// LoginViewModel.swift
func login() async {
    try await AuthManager.shared.login(email: email, password: password)
}
```

**Network Request**:
```http
POST /api/auth/login HTTP/1.1
Host: localhost:3000
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

**Backend Validation** (`apps/web/src/app/api/auth/login/route.ts`):
1. Find user by email in PostgreSQL
2. Compare password hash using bcrypt
3. Check if user is active
4. Generate JWT token with user ID and `tokenVersion`
5. Generate CSRF token
6. Return user details + tokens

**Response**:
```json
{
  "user": {
    "id": "user_abc123",
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyX2FiYzEyMyIsInRva2VuVmVyc2lvbiI6MSwiaWF0IjoxNzM1NzQwMDAwfQ.abc123",
  "csrfToken": "csrf_xyz789"
}
```

---

### 2. Token Storage

**App Flow** (`AuthManager.swift`):
```swift
// Save JWT token to Keychain
saveToken(response.token)

// Save CSRF token to Keychain
saveCSRFToken(response.csrfToken)

// Update app state
currentUser = response.user
isAuthenticated = true
```

**Keychain Storage**:
- Service: `com.pagespace.mobile`
- Account (JWT): `jwt_token`
- Account (CSRF): `csrf_token`
- Accessibility: `kSecAttrAccessibleAfterFirstUnlock`

**Why Keychain?**
- Encrypted storage
- Survives app deletion (if not excluded)
- Protected by iOS security framework
- Automatically syncs across devices (if enabled)

---

### 3. Authenticated Requests

**When making API calls**, the `APIClient` automatically includes authentication headers:

```swift
// APIClient.swift
private func addAuthHeaders(to request: inout URLRequest, method: HTTPMethod) {
    // Add JWT token
    if let token = AuthManager.shared.getToken() {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    // Add CSRF token for write operations
    if method != .GET, let csrfToken = AuthManager.shared.getCSRFToken() {
        request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
    }
}
```

**Example Request**:
```http
GET /api/ai_conversations HTTP/1.1
Host: localhost:3000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Example Write Request**:
```http
POST /api/ai_conversations HTTP/1.1
Host: localhost:3000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
X-CSRF-Token: csrf_xyz789
Content-Type: application/json

{"title": "New Conversation"}
```

---

### 4. Backend Token Validation

**Backend Flow** (`apps/web/src/lib/auth/index.ts`):

```typescript
// Extract token from Authorization header
const authHeader = request.headers.get('Authorization');
const token = authHeader?.replace('Bearer ', '');

// Verify JWT signature and decode payload
const payload = await verifyJWT(token);
// { userId: "user_abc123", tokenVersion: 1 }

// Load user from database
const user = await db.query.users.findFirst({
  where: eq(users.id, payload.userId)
});

// Validate token version (handles forced logout)
if (user.tokenVersion !== payload.tokenVersion) {
  throw new Error('Token revoked - please log in again');
}

// For write operations, validate CSRF token
if (method !== 'GET') {
  const csrfToken = request.headers.get('X-CSRF-Token');
  validateCSRFToken(csrfToken);
}

// Return authenticated user
return { user, userId: user.id };
```

---

### 5. Token Expiration & Refresh

**Current Implementation**: No auto-refresh (stateless JWT)

**Token Lifetime**: Configurable (default: 7 days)

**Expiration Handling**:
1. Backend returns `401 Unauthorized` when token expires
2. Mobile app catches error in `APIClient`
3. App shows login screen
4. User re-authenticates

```swift
// APIClient.swift
private func handleHTTPStatus(_ statusCode: Int) throws {
    switch statusCode {
    case 401:
        // Token expired or invalid
        await MainActor.run {
            AuthManager.shared.logout()
        }
        throw APIError.unauthorized
    // ...
    }
}
```

**Future Enhancement**: Implement refresh tokens for seamless re-authentication

---

### 6. Token Revocation (Force Logout)

**Use Case**: User changes password, admin revokes access, security breach

**Mechanism**: Increment `tokenVersion` in database

```sql
UPDATE users SET token_version = token_version + 1 WHERE id = 'user_abc123';
```

**Result**:
- All existing tokens become invalid
- User must log in again to get new token with updated version

**Mobile Handling**:
- Receives `401 Unauthorized`
- Automatically logs out and shows login screen

---

### 7. Logout Flow

**User Action**: Taps "Sign Out" in `SettingsView`

**App Flow**:
```swift
// AuthManager.swift
func logout() {
    // Remove tokens from Keychain
    deleteToken()
    deleteCSRFToken()

    // Clear user state
    currentUser = nil
    csrfToken = nil
    isAuthenticated = false

    // Disconnect from real-time service
    RealtimeService.shared.disconnect()
}
```

**UI Update**: App automatically shows `LoginView` (reactive to `isAuthenticated`)

**No Backend Call**: Logout is client-side only (JWT is stateless)

---

## Security Considerations

### 1. Keychain Protection

✅ **Good**:
- Tokens encrypted by iOS
- Protected by device passcode/biometrics
- Survives app reinstall (if configured)

⚠️ **Risks**:
- Jailbroken devices may expose Keychain
- Shared devices allow access to tokens

**Mitigation**: Add biometric authentication before showing sensitive data

---

### 2. Token Transmission

✅ **Good**:
- HTTPS encrypts tokens in transit
- Authorization header (not URL params)

⚠️ **Risks**:
- Man-in-the-middle attacks on HTTP
- Certificate pinning not implemented

**Mitigation**: Enforce HTTPS in production, consider certificate pinning

---

### 3. CSRF Protection

✅ **Good**:
- CSRF tokens required for write operations
- Tokens tied to user session

⚠️ **Risks**:
- Mobile apps less vulnerable to CSRF (no browser cookies)
- CSRF token stored alongside JWT (both in Keychain)

**Note**: CSRF protection is more critical for web apps than mobile apps

---

### 4. Token Storage Alternatives

| Method | Security | Persistence | Sync |
|--------|----------|-------------|------|
| **Keychain** | ✅ High | ✅ Yes | ✅ Optional |
| UserDefaults | ❌ Low (plaintext) | ✅ Yes | ❌ No |
| In-Memory | ✅ High | ❌ No | ❌ No |
| SQLite | ⚠️ Medium (encrypted DB) | ✅ Yes | ❌ No |

**Recommendation**: Keychain (current implementation) ✅

---

## Error Handling

### Common Authentication Errors

#### 1. Invalid Credentials (401)
```json
{
  "error": "Invalid email or password",
  "code": "INVALID_CREDENTIALS"
}
```

**Mobile Handling**:
- Show error message in `LoginView`
- Do not store tokens
- Allow user to retry

---

#### 2. Token Expired (401)
```json
{
  "error": "Token expired - please log in again",
  "code": "TOKEN_EXPIRED"
}
```

**Mobile Handling**:
- Automatic logout via `APIClient`
- Clear tokens from Keychain
- Redirect to login screen

---

#### 3. Token Revoked (401)
```json
{
  "error": "Token revoked - please log in again",
  "code": "TOKEN_REVOKED"
}
```

**Mobile Handling**: Same as token expired

---

#### 4. Rate Limited (429)
```json
{
  "error": "Too many login attempts - please try again later",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

**Mobile Handling**:
- Show error message
- Disable login button temporarily
- Implement exponential backoff

---

## Testing Authentication

### 1. Test Login Flow

```swift
// LoginViewModelTests.swift
func testSuccessfulLogin() async {
    let viewModel = LoginViewModel()
    viewModel.email = "test@example.com"
    viewModel.password = "password123"

    await viewModel.login()

    XCTAssertTrue(AuthManager.shared.isAuthenticated)
    XCTAssertNotNil(AuthManager.shared.currentUser)
}
```

---

### 2. Test Token Storage

```swift
func testTokenPersistence() {
    let authManager = AuthManager.shared

    // Login
    await authManager.login(email: "test@example.com", password: "password")

    // Kill app and restart
    // Token should still be available
    XCTAssertNotNil(authManager.getToken())
}
```

---

### 3. Test Unauthorized Handling

```swift
func testUnauthorizedResponse() async {
    // Mock API to return 401
    let mockAPI = MockAPIClient(statusCode: 401)

    do {
        _ = try await mockAPI.request(endpoint: "/api/ai_conversations")
        XCTFail("Should throw unauthorized error")
    } catch APIError.unauthorized {
        // Expected
        XCTAssertFalse(AuthManager.shared.isAuthenticated)
    }
}
```

---

## Future Enhancements

### 1. Biometric Authentication
- Require Face ID/Touch ID before accessing app
- Store tokens behind biometric protection

### 2. Refresh Tokens
- Implement refresh token flow
- Auto-refresh JWT before expiration
- Seamless user experience

### 3. Certificate Pinning
- Pin SSL certificates for API endpoints
- Prevent man-in-the-middle attacks
- Enhanced security for production

### 4. OAuth/SSO Support
- Google Sign-In
- Apple Sign-In
- Enterprise SSO (SAML, OIDC)

---

## Conclusion

The PageSpace mobile authentication flow provides:

✅ **Secure token storage** via iOS Keychain
✅ **JWT-based stateless authentication**
✅ **CSRF protection** for write operations
✅ **Automatic token validation** on backend
✅ **Graceful error handling** with auto-logout

This architecture balances security, user experience, and simplicity, making it suitable for a mobile AI companion app.
