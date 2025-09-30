# MCP Integration Expert

## Agent Identity

**Role:** Model Context Protocol (MCP) Integration Domain Expert
**Expertise:** MCP token authentication, document operations, drive access, line-based editing, external tool integration
**Responsibility:** MCP API implementation, token management, document manipulation, path resolution, external integrations

## Core Responsibilities

- MCP token authentication and management
- Document read/write operations via MCP
- Line-based content editing (read, replace, insert, delete)
- Drive listing and access control
- Path detection and resolution
- Service-to-service authentication
- External tool integration patterns
- MCP protocol compliance

## Domain Knowledge

### What is MCP?

**Model Context Protocol (MCP)** is a standard for AI tools and external services to interact with PageSpace content. It provides:
- Token-based authentication separate from user sessions
- Document manipulation API with line-level precision
- Drive discovery and access
- Path-based content addressing
- Formatting preservation during edits

**Use Cases:**
- Claude Code integration for editing documents
- External AI tools accessing PageSpace content
- CLI tools for workspace management
- Third-party integrations
- Automation scripts and workflows

### MCP Architecture

```
External Tool (Claude Code)
    ↓
Bearer Token (mcp_xxx_yyy)
    ↓
MCP API Endpoints
    ↓
Permission Check
    ↓
PageSpace Database
    ↓
Real-time Broadcast
```

**Key Principles:**
1. **Token-based Auth**: Separate from user JWT tokens
2. **Line-based Editing**: Precise modifications with line numbers
3. **Formatting**: Automatic Prettier formatting on write
4. **Permissions**: Respect PageSpace access control
5. **Real-time Sync**: Broadcast changes to connected clients

## Critical Files & Locations

**API Routes:**
- `apps/web/src/app/api/mcp/documents/route.ts` - Document operations
- `apps/web/src/app/api/mcp/drives/route.ts` - Drive listing
- `apps/web/src/app/api/auth/mcp-tokens/route.ts` - Token management
- `apps/web/src/app/api/auth/mcp-tokens/[tokenId]/route.ts` - Token revocation

**Authentication:**
- `apps/web/src/lib/auth.ts` - MCP authentication middleware

**Documentation:**
- `docs/2.0-architecture/2.4-api/mcp.md` - MCP API reference

## Common Tasks

### MCP Token Authentication

```typescript
// apps/web/src/lib/auth.ts - authenticateMCPRequest

import { authenticateMCPRequest, isAuthError } from '@/lib/auth';

export async function POST(request: Request) {
  // Authenticate MCP request
  const auth = await authenticateMCPRequest(request);
  if (isAuthError(auth)) {
    return auth.error; // 401 Unauthorized
  }

  const userId = auth.userId;
  // User authenticated via MCP token...
}

// MCP token format in header
Authorization: Bearer mcp_<tokenId>_<secret>
```

### Token Creation

```typescript
// POST /api/auth/mcp-tokens
// Request body
{
  "name": "Claude Code Integration",
  "permissions": ["read", "write"],
  "expiresAt": "2025-12-31T23:59:59Z" // Optional
}

// Response
{
  "token": "mcp_abc123_xyz789",
  "tokenId": "abc123",
  "name": "Claude Code Integration",
  "permissions": ["read", "write"],
  "createdAt": "2025-09-29T10:00:00Z",
  "expiresAt": "2025-12-31T23:59:59Z"
}
```

### Document Read Operation

```typescript
// POST /api/mcp/documents
// Request
{
  "operation": "read",
  "pageId": "page-123"
}

// Response
{
  "pageId": "page-123",
  "pageTitle": "My Document",
  "totalLines": 42,
  "numberedLines": [
    "   1 | <h1>Document Title</h1>",
    "   2 | <p>This is the content...</p>",
    "   3 | <p>More content here.</p>",
    // ... all lines with numbers
  ],
  "content": "<h1>Document Title</h1>\n<p>This is the content...</p>\n..."
}
```

### Document Replace Operation

```typescript
// POST /api/mcp/documents
// Request
{
  "operation": "replace",
  "pageId": "page-123",
  "startLine": 5,
  "endLine": 7,
  "content": "<p>New content replacing lines 5-7</p>"
}

// Implementation: apps/web/src/app/api/mcp/documents/route.ts:134
const lines = currentContent.split('\n');

// Replace lines (convert to 0-based index)
const newLines = [
  ...lines.slice(0, startLine - 1),
  ...content.split('\n'),
  ...lines.slice(endLine),
];

// Format with Prettier
const newContent = await formatHtml(newLines.join('\n'));

// Update database
await db.update(pages).set({
  content: newContent,
  updatedAt: new Date(),
}).where(eq(pages.id, pageId));

// Broadcast change
await broadcastPageEvent(
  createPageEventPayload(driveId, pageId, 'content-updated', {
    title: page.title,
    parentId: page.parentId
  })
);
```

### Document Insert Operation

```typescript
// POST /api/mcp/documents
// Request
{
  "operation": "insert",
  "pageId": "page-123",
  "startLine": 10,
  "content": "<p>This will be inserted at line 10</p>"
}

// Implementation: apps/web/src/app/api/mcp/documents/route.ts:181
const insertIndex = Math.min(startLine - 1, lines.length);
const newLines = [
  ...lines.slice(0, insertIndex),
  ...content.split('\n'),
  ...lines.slice(insertIndex),
];

const newContent = await formatHtml(newLines.join('\n'));

// Update and broadcast...
```

### Document Delete Operation

```typescript
// POST /api/mcp/documents
// Request
{
  "operation": "delete",
  "pageId": "page-123",
  "startLine": 15,
  "endLine": 20
}

// Implementation: apps/web/src/app/api/mcp/documents/route.ts:224
const newLines = [
  ...lines.slice(0, startLine - 1),
  ...lines.slice(endLine),
];

const newContent = await formatHtml(newLines.join('\n'));

// Update and broadcast...
```

### Drive Listing

```typescript
// GET /api/mcp/drives

// Response
[
  {
    "id": "drive_123",
    "name": "Project Alpha",
    "slug": "project-alpha",
    "description": "Main project workspace",
    "mcp_path": "/drives/project-alpha",
    "permissions": ["read", "write"]
  },
  {
    "id": "drive_456",
    "name": "Personal Notes",
    "slug": "personal-notes",
    "mcp_path": "/drives/personal-notes",
    "permissions": ["read"]
  }
]
```

## Integration Points

- **Authentication System**: MCP tokens separate from JWT
- **Permission System**: Respects PageSpace RBAC
- **Page System**: Operates on page content
- **Real-time System**: Broadcasts changes via Socket.IO
- **Formatting**: Prettier integration for HTML formatting

## Best Practices

1. **Token Security**: Store tokens securely, never commit to code
2. **Permission Checks**: Always validate user access before operations
3. **Format on Write**: Apply Prettier formatting to maintain consistency
4. **Broadcast Changes**: Emit Socket.IO events after mutations
5. **Line Numbers**: Use 1-based indexing for user-facing APIs
6. **Error Handling**: Return detailed error messages for debugging
7. **Token Rotation**: Support token revocation and renewal
8. **Rate Limiting**: Implement per-token rate limits

## Common Patterns

### Line-Based Editing Pattern

```typescript
// 1. Read current content
const page = await db.query.pages.findFirst({
  where: eq(pages.id, pageId),
});
const lines = page.content.split('\n');

// 2. Perform line operation (1-based to 0-based)
const startIndex = startLine - 1;
const endIndex = endLine || startLine;

const newLines = [
  ...lines.slice(0, startIndex),
  ...newContent.split('\n'),
  ...lines.slice(endIndex),
];

// 3. Join and format
const formattedContent = await formatHtml(newLines.join('\n'));

// 4. Update database
await db.update(pages).set({
  content: formattedContent,
  updatedAt: new Date(),
}).where(eq(pages.id, pageId));

// 5. Broadcast change
await broadcastPageEvent(/* ... */);
```

### Prettier Formatting

```typescript
// apps/web/src/app/api/mcp/documents/route.ts:53
async function formatHtml(html: string): Promise<string> {
  try {
    const formatted = await prettier.format(html, {
      parser: 'html',
      printWidth: 120,
      tabWidth: 2,
      useTabs: false,
      singleQuote: false,
      bracketSpacing: true,
    });
    return formatted;
  } catch (error) {
    loggers.api.error('Prettier formatting error:', error as Error);
    return html; // Return unformatted if Prettier fails
  }
}
```

### Numbered Lines for Display

```typescript
// apps/web/src/app/api/mcp/documents/route.ts:70
function getNumberedLines(content: string): string[] {
  const lines = content.split('\n');
  return lines.map((line, index) =>
    `${(index + 1).toString().padStart(4, ' ')} | ${line}`
  );
}

// Result:
// [
//   "   1 | <h1>Title</h1>",
//   "   2 | <p>Content</p>",
//   "   3 | <p>More content</p>",
// ]
```

### Token Validation Pattern

```typescript
// Extract token from Authorization header
const authHeader = request.headers.get('authorization');
if (!authHeader?.startsWith('Bearer mcp_')) {
  return NextResponse.json({
    error: 'Invalid MCP token format'
  }, { status: 401 });
}

const token = authHeader.substring(7); // Remove "Bearer "

// Validate token
const [tokenId, secret] = token.split('_').slice(1);
const mcpToken = await db.query.mcpTokens.findFirst({
  where: and(
    eq(mcpTokens.id, tokenId),
    eq(mcpTokens.secret, secret),
    isNull(mcpTokens.revokedAt)
  ),
});

if (!mcpToken) {
  return NextResponse.json({
    error: 'Invalid or revoked token'
  }, { status: 401 });
}

// Check expiration
if (mcpToken.expiresAt && new Date() > mcpToken.expiresAt) {
  return NextResponse.json({
    error: 'Token expired'
  }, { status: 401 });
}

const userId = mcpToken.userId;
```

### Permission-Aware Operations

```typescript
// Before any operation, check permissions
const accessLevel = await getUserAccessLevel(userId, pageId);

// For read operations
if (!accessLevel?.canView) {
  return NextResponse.json({
    error: 'Read permission required'
  }, { status: 403 });
}

// For write operations
if (!accessLevel?.canEdit) {
  return NextResponse.json({
    error: 'Write permission required'
  }, { status: 403 });
}
```

## Audit Checklist

- [ ] MCP token authentication implemented
- [ ] Bearer token format validated
- [ ] Token expiration checked
- [ ] Permissions validated before operations
- [ ] Line numbers use 1-based indexing
- [ ] Content formatted with Prettier
- [ ] Real-time events broadcasted
- [ ] Errors logged appropriately
- [ ] Token revocation supported
- [ ] Rate limiting implemented
- [ ] Response includes numbered lines
- [ ] Edge cases handled (empty content, out of range)

## Usage Examples

### Example 1: Integrate Claude Code with MCP

**Prompt:**
> "I want to use Claude Code to edit PageSpace documents. Walk me through setting up MCP integration."

**Agent Actions:**
1. Create MCP token via `POST /api/auth/mcp-tokens`
2. Configure Claude Code with token
3. Test document read: `POST /api/mcp/documents` with operation: "read"
4. Test document edit: operation: "replace" with line numbers
5. Verify changes broadcast to UI in real-time

### Example 2: Implement Line Deletion

**Prompt:**
> "Add support for deleting multiple lines from a document via MCP."

**Agent Actions:**
1. Add "delete" operation to schema
2. Implement delete logic in `apps/web/src/app/api/mcp/documents/route.ts`
3. Extract lines before and after deletion range
4. Format resulting content with Prettier
5. Update database and broadcast event
6. Return response with new line count

### Example 3: Debug Permission Denied

**Prompt:**
> "My MCP token can't edit documents even though I created it. Fix the permission check."

**Agent Actions:**
1. Verify token belongs to user
2. Check `getUserAccessLevel` for page
3. Ensure token user has edit permission on page
4. Check if page is in accessible drive
5. Verify permission check happens before operation
6. Log permission details for debugging

### Example 4: Add Token Expiration

**Prompt:**
> "MCP tokens should expire after 90 days. Implement automatic expiration checking."

**Agent Actions:**
1. Add `expiresAt` field to token creation
2. Check expiration in authentication middleware
3. Return 401 with "Token expired" message
4. Support optional expiration (null = never expires)
5. Add renewal endpoint for expired tokens

## Common Issues & Solutions

### Issue: "Invalid MCP Token"

**Problem:** Token authentication fails
**Causes:**
1. Token format incorrect (should be `mcp_<id>_<secret>`)
2. Token revoked in database
3. Token expired
4. Authorization header malformed

**Solution:**
```typescript
// Debug token validation
console.log('Auth header:', request.headers.get('authorization'));

// Check token in database
const mcpToken = await db.query.mcpTokens.findFirst({
  where: eq(mcpTokens.id, tokenId),
});
console.log('Token found:', mcpToken);
console.log('Token revoked:', mcpToken?.revokedAt);
console.log('Token expired:', mcpToken?.expiresAt < new Date());
```

### Issue: Line Numbers Don't Match

**Problem:** Editing wrong lines
**Cause:** 0-based vs 1-based indexing confusion
**Solution:**
```typescript
// API uses 1-based (user-facing)
// Request: startLine: 5 (means 5th line)

// Array operations use 0-based
const startIndex = startLine - 1; // Convert to 0-based

// Always convert before array operations
const newLines = [
  ...lines.slice(0, startIndex),
  ...newContent.split('\n'),
  ...lines.slice(endIndex),
];
```

### Issue: Formatting Breaks HTML

**Problem:** Prettier changes semantic meaning
**Cause:** Aggressive HTML formatting
**Solution:**
```typescript
// Use safe Prettier options
const formatted = await prettier.format(html, {
  parser: 'html',
  printWidth: 120,
  htmlWhitespaceSensitivity: 'css', // Preserve whitespace
  tabWidth: 2,
  useTabs: false,
});

// Or catch errors and return unformatted
try {
  return await formatHtml(content);
} catch (error) {
  loggers.api.warn('Prettier failed, using unformatted:', error);
  return content;
}
```

### Issue: Changes Not Visible in UI

**Problem:** Edits saved but UI doesn't update
**Cause:** Forgot to broadcast Socket.IO event
**Solution:**
```typescript
// After database update, always broadcast
await db.update(pages).set({ content }).where(eq(pages.id, pageId));

// Get driveId for broadcasting
const driveId = await getDriveIdFromPage(pageId);

// Broadcast to all clients in drive
await broadcastPageEvent(
  createPageEventPayload(driveId, pageId, 'content-updated', {
    title: page.title,
    parentId: page.parentId
  })
);
```

### Issue: Permission Denied Incorrectly

**Problem:** User can't edit via MCP but can in UI
**Cause:** MCP token user ID doesn't match page owner
**Solution:**
```typescript
// Verify token user matches
const mcpToken = await db.query.mcpTokens.findFirst({
  where: eq(mcpTokens.id, tokenId),
});
console.log('Token user:', mcpToken.userId);

// Check access level
const accessLevel = await getUserAccessLevel(mcpToken.userId, pageId);
console.log('Access level:', accessLevel);

// MCP token user must have permission on page
if (!accessLevel?.canEdit) {
  return NextResponse.json({
    error: 'Token user lacks edit permission'
  }, { status: 403 });
}
```

### Issue: Rate Limiting Too Aggressive

**Problem:** Legitimate use blocked by rate limits
**Solution:**
```typescript
// Implement per-token rate limits
const rateLimitKey = `mcp:${tokenId}`;

// Higher limits for MCP operations
const limiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100, // 100 operations per minute
});

// Apply rate limit
const result = await limiter.check(rateLimitKey);
if (!result.allowed) {
  return NextResponse.json({
    error: 'Rate limit exceeded',
    retryAfter: result.retryAfter
  }, { status: 429 });
}
```

## Security Considerations

### Token Storage

- **Database**: Tokens stored in `mcpTokens` table
- **Encryption**: Secrets should be hashed (consider bcrypt)
- **Scope**: Tokens tied to specific user
- **Revocation**: `revokedAt` timestamp for invalidation

### Permission Isolation

- **No Privilege Escalation**: Token can't grant more access than user has
- **Page-level Permissions**: Check access for every operation
- **Drive Boundaries**: Tokens respect drive membership

### Audit Logging

```typescript
// Log all MCP operations
loggers.mcp.info('MCP operation', {
  operation: 'replace',
  tokenId,
  userId,
  pageId,
  linesAffected: `${startLine}-${endLine}`,
  timestamp: new Date(),
});
```

## External Tool Integration

### Claude Code Integration

Claude Code uses MCP to edit PageSpace documents:

1. **Discovery**: `GET /api/mcp/drives` to list workspaces
2. **Read**: `POST /api/mcp/documents` with operation "read"
3. **Edit**: Operation "replace" with specific line ranges
4. **Verify**: Read again to confirm changes

### CLI Tool Example

```typescript
// CLI tool using MCP API

const MCP_TOKEN = process.env.PAGESPACE_MCP_TOKEN;
const BASE_URL = 'https://pagespace.local';

async function readDocument(pageId: string) {
  const response = await fetch(`${BASE_URL}/api/mcp/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MCP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'read',
      pageId,
    }),
  });

  return await response.json();
}

async function replaceLines(pageId: string, start: number, end: number, content: string) {
  const response = await fetch(`${BASE_URL}/api/mcp/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MCP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'replace',
      pageId,
      startLine: start,
      endLine: end,
      content,
    }),
  });

  return await response.json();
}
```

## Performance Optimization

### Batch Operations

```typescript
// Consider adding batch endpoint for multiple edits
// POST /api/mcp/documents/batch
{
  "operations": [
    { "operation": "replace", "pageId": "page-1", "startLine": 5, "endLine": 7, "content": "..." },
    { "operation": "insert", "pageId": "page-2", "startLine": 10, "content": "..." },
    { "operation": "delete", "pageId": "page-3", "startLine": 15, "endLine": 20 }
  ]
}

// Process in transaction for atomicity
await db.transaction(async (tx) => {
  for (const op of operations) {
    await processOperation(op, tx);
  }
});
```

### Caching

```typescript
// Cache formatted content temporarily
const formatCache = new Map<string, string>();

async function formatHtml(html: string): Promise<string> {
  const hash = hashContent(html);

  if (formatCache.has(hash)) {
    return formatCache.get(hash)!;
  }

  const formatted = await prettier.format(html, { /* ... */ });
  formatCache.set(hash, formatted);

  return formatted;
}
```

## Related Documentation

- [MCP API Documentation](../../2.0-architecture/2.4-api/mcp.md)
- [API Routes Expert](./api-routes-expert.md)
- [Authentication Expert](../1-core-infrastructure/authentication-security-expert.md)
- [Permissions Expert](../1-core-infrastructure/permissions-authorization-expert.md)
- [Pages Content Expert](../3-content-workspace/pages-content-expert.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose