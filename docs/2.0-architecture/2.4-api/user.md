# User Routes

### GET /api/users/find

**Purpose:** Finds a user by email.
**Auth Required:** Yes
**Request Schema:**
- email: string (query parameter)
**Response Schema:** User object.
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### GET /api/users/search

**Purpose:** Searches for users by name or email with pagination support.
**Auth Required:** Yes
**Request Schema:**
- q: string (query parameter - search query)
- limit: number (query parameter - optional, default 10)
- offset: number (query parameter - optional, default 0)
**Response Schema:** Array of user objects with id, name, email, and image.
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/users/profile

**Purpose:** Retrieves the profile information for the authenticated user.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** User profile object:
- userId: string
- email: string
- displayName: string
- username: string | null
- bio: string | null
- avatarUrl: string | null
- isPublic: boolean
**Implementation Notes:**
- Returns basic user info if no profile exists
- Profile data is stored in separate userProfiles table
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### PATCH /api/users/profile

**Purpose:** Updates the profile information for the authenticated user.
**Auth Required:** Yes
**Request Schema:**
- displayName: string (optional)
- username: string (optional)
- bio: string (optional)
- avatarUrl: string (optional)
- isPublic: boolean (optional)
**Response Schema:** Updated user profile object.
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

## Account Management

### GET /api/account

**Purpose:** Retrieves the authenticated user's account details with token version checking.
**Auth Required:** Yes (via accessToken cookie)
**Request Schema:** None
**Response Schema:** User account object:
- id: string
- name: string
- email: string
- image: string | null
**Implementation Notes:**
- Validates token version against database
- Returns 401 if token version mismatch
**Status Codes:** 200 (OK), 401 (Unauthorized - for invalid token or version mismatch)
**Next.js 15 Handler:** async function returning Response
**Last Updated:** 2025-08-21

### PATCH /api/account

**Purpose:** Updates the authenticated user's account information.
**Auth Required:** Yes
**Request Schema:**
- name: string (optional)
- email: string (optional)
**Response Schema:** Updated user account object.
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### POST /api/account/password

**Purpose:** Updates the authenticated user's password.
**Auth Required:** Yes
**Request Schema:**
- currentPassword: string
- newPassword: string (min 8 characters)
**Response Schema:** Success message.
**Implementation Notes:**
- Verifies current password before update
- Hashes new password with bcrypt
- Increments token version to invalidate existing sessions
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

## Admin User Management

### GET /api/admin/users

**Purpose:** Lists all users in the system (admin only).
**Auth Required:** Yes (admin role required)
**Request Schema:** None
**Response Schema:** Array of user objects with full details.
**Status Codes:** 200 (OK), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### PATCH /api/admin/users/[userId]

**Purpose:** Updates a user's information (admin only).
**Auth Required:** Yes (admin role required)
**Request Schema:**
- userId: string (dynamic parameter)
- name: string (optional)
- email: string (optional)
- role: string (optional)
**Response Schema:** Updated user object.
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21