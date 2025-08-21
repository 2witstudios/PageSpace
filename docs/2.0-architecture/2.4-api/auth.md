# Auth Routes

## Core Authentication

### POST /api/auth/login

**Purpose:** Authenticates a user and issues access and refresh tokens.
**Auth Required:** No
**Request Schema:**
- email: string (email format)
- password: string
**Response Schema:** User object on success, error object on failure.
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### POST /api/auth/logout

**Purpose:** Logs out a user by invalidating their refresh token and clearing cookies.
**Auth Required:** No (handles token check internally)
**Request Schema:** None
**Response Schema:** Message object
**Status Codes:** 200 (OK)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### GET /api/auth/me

**Purpose:** Retrieves the currently authenticated user's details.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** User object on success, error object on failure.
**Status Codes:** 200 (OK), 401 (Unauthorized)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### POST /api/auth/refresh

**Purpose:** Refreshes access and refresh tokens using an existing refresh token.
**Auth Required:** No (uses refresh token from cookie)
**Request Schema:** None
**Response Schema:** Message object on success, error object on failure.
**Status Codes:** 200 (OK), 401 (Unauthorized)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### POST /api/auth/signup

**Purpose:** Registers a new user and creates a personal drive for them.
**Auth Required:** No
**Request Schema:**
- name: string
- email: string (email format)
- password: string (min 8 characters)
**Response Schema:** Message object on success, error object on failure.
**Status Codes:** 201 (Created), 400 (Bad Request), 409 (Conflict), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

## CSRF Protection

### GET /api/auth/csrf

**Purpose:** Generates a CSRF token for the current session to protect against CSRF attacks.
**Auth Required:** No (checks for access token internally)
**Request Schema:** None
**Response Schema:** 
- csrfToken: string
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

## OAuth Authentication

### POST /api/auth/google/signin

**Purpose:** Initiates Google OAuth sign-in flow with rate limiting.
**Auth Required:** No
**Request Schema:**
- returnUrl: string (optional - URL to redirect after authentication)
**Response Schema:** OAuth redirect URL or error message
**Status Codes:** 200 (OK), 400 (Bad Request), 429 (Too Many Requests), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### GET /api/auth/google/callback

**Purpose:** Handles Google OAuth callback and creates/updates user session.
**Auth Required:** No
**Request Schema:** OAuth callback parameters (code, state) via query string
**Response Schema:** Redirect to application with authentication cookies set
**Status Codes:** 302 (Redirect), 400 (Bad Request), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with redirect response
**Last Updated:** 2025-08-21

## MCP Token Management

### GET /api/auth/mcp-tokens

**Purpose:** Lists all MCP (Model Context Protocol) tokens for the authenticated user.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** Array of MCP token objects:
- id: string
- name: string
- token: string (masked with only last 4 characters visible)
- createdAt: timestamp
- lastUsedAt: timestamp (nullable)
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### POST /api/auth/mcp-tokens

**Purpose:** Creates a new MCP token for API authentication.
**Auth Required:** Yes
**Request Schema:**
- name: string (1-100 characters)
**Response Schema:** 
- id: string
- name: string
- token: string (full token, only shown on creation)
- createdAt: timestamp
**Status Codes:** 201 (Created), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21

### DELETE /api/auth/mcp-tokens/[tokenId]

**Purpose:** Deletes an MCP token.
**Auth Required:** Yes
**Request Schema:**
- tokenId: string (dynamic parameter)
**Response Schema:** Success message
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response/NextResponse
**Last Updated:** 2025-08-21