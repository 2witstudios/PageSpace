# MCP (Model Context Protocol) API

## Overview

The MCP API provides integration endpoints for external tools and AI agents to interact with PageSpace content through the Model Context Protocol standard. These endpoints enable secure, token-based access to drives, documents, and workspace content for AI tools and external integrations.

**Authentication:** All MCP endpoints require Bearer token authentication using MCP-specific tokens, separate from user session tokens.

## API Routes

### GET /api/mcp/drives

**Purpose:** Lists drives accessible via MCP for external integrations.
**Auth Required:** Yes (MCP Bearer token)
**Request Schema:** None
**Response Schema:** Array of drive objects formatted for MCP:
```json
[
  {
    "id": "drive_123",
    "name": "Project Alpha",
    "slug": "project-alpha",
    "description": "Main project workspace",
    "mcp_path": "/drives/project-alpha",
    "permissions": ["read", "write"]
  }
]
```
**Implementation Notes:**
- Returns only drives accessible to the MCP token holder
- Formats drive data according to MCP specifications
- Includes MCP-specific path mappings
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### POST /api/mcp/documents

**Purpose:** MCP document operations (read, replace, insert, delete) with formatting support.
**Auth Required:** Yes (MCP Bearer token)
**Request Schema:**
- operation: string ('read' | 'replace' | 'insert' | 'delete')
- path: string (MCP document path)
- content: string (for write operations)
- lineNumber: number (for line-specific operations)
- format: string (optional - 'markdown' | 'plain' | 'html')
**Response Schema:** 
```json
{
  "success": true,
  "content": "document content",
  "format": "markdown",
  "metadata": {
    "lastModified": "2025-08-21T10:30:00Z",
    "size": 1024,
    "encoding": "utf-8"
  }
}
```
**Implementation Notes:**
- Supports line-based operations for precise editing
- Automatic format detection and conversion
- Preserves document metadata and formatting
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/mcp/documents

**Purpose:** Retrieves documents accessible via MCP.
**Auth Required:** Yes (MCP Bearer token)
**Request Schema:**
- driveId: string (query parameter - optional)
- pageId: string (query parameter - optional)
- path: string (query parameter - MCP path)
- format: string (query parameter - optional, 'markdown' | 'plain' | 'html')
**Response Schema:** Document content formatted for MCP.
```json
{
  "id": "page_123",
  "title": "Document Title",
  "content": "# Document Content\n\nThis is the document content...",
  "format": "markdown",
  "path": "/drives/project-alpha/docs/readme",
  "lastModified": "2025-08-21T10:30:00Z",
  "permissions": ["read", "write"]
}
```
**Implementation Notes:**
- Supports both ID-based and path-based document access
- Automatic format conversion based on request
- Respects permissions for MCP token
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/mcp/detect-paths

**Purpose:** Detects and validates file paths for MCP operations.
**Auth Required:** Yes (MCP Bearer token)
**Request Schema:**
- path: string (query parameter - path to validate)
**Response Schema:** Path validation result.
```json
{
  "valid": true,
  "normalized": "/drives/project-alpha/docs/readme.md",
  "type": "document",
  "exists": true,
  "permissions": ["read", "write"],
  "metadata": {
    "driveId": "drive_123",
    "pageId": "page_456",
    "parentPath": "/drives/project-alpha/docs"
  }
}
```
**Implementation Notes:**
- Normalizes paths to PageSpace internal format
- Validates path syntax and accessibility
- Returns detailed metadata for valid paths
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

## MCP Token Authentication

### Token Format
MCP tokens are Bearer tokens with the format:
```
Authorization: Bearer mcp_<token_id>_<secret>
```

### Token Permissions
MCP tokens can have different permission levels:
- **read**: Read access to drives and documents
- **write**: Write access to modify documents
- **admin**: Administrative access for drive management

### Token Management
MCP tokens are managed through the auth API:
- **Create:** `POST /api/auth/mcp-tokens`
- **List:** `GET /api/auth/mcp-tokens`
- **Revoke:** `DELETE /api/auth/mcp-tokens/[tokenId]`

## Path Resolution

### MCP Path Format
MCP uses a hierarchical path system:
```
/drives/{drive-slug}/{page-path}
/drives/project-alpha/docs/readme.md
/drives/personal/notes/meeting-2025-08-21.md
```

### Path Normalization
- Drive slugs are converted to internal drive IDs
- Page paths are resolved to PageSpace page hierarchy
- File extensions are optional and inferred from content type

## Document Operations

### Read Operations
```http
GET /api/mcp/documents?path=/drives/project-alpha/readme.md
```

### Write Operations
```http
POST /api/mcp/documents
Content-Type: application/json

{
  "operation": "replace",
  "path": "/drives/project-alpha/readme.md",
  "content": "# Updated README\n\nThis is the updated content."
}
```

### Line-Specific Operations
```http
POST /api/mcp/documents
Content-Type: application/json

{
  "operation": "insert",
  "path": "/drives/project-alpha/readme.md",
  "lineNumber": 5,
  "content": "This line will be inserted at line 5"
}
```

## Error Handling

### Authentication Errors
```json
{
  "error": "Invalid MCP token",
  "code": "MCP_AUTH_FAILED",
  "details": {
    "tokenId": "mcp_abc123",
    "reason": "Token expired"
  }
}
```

### Path Errors
```json
{
  "error": "Path not found",
  "code": "MCP_PATH_NOT_FOUND", 
  "details": {
    "path": "/drives/nonexistent/file.md",
    "suggestions": [
      "/drives/project-alpha/file.md",
      "/drives/personal/file.md"
    ]
  }
}
```

### Permission Errors
```json
{
  "error": "Insufficient permissions",
  "code": "MCP_PERMISSION_DENIED",
  "details": {
    "required": "write",
    "granted": ["read"],
    "path": "/drives/protected/file.md"
  }
}
```

## Security Features

### Token Rotation
- MCP tokens can be rotated for security
- Old tokens remain valid during grace period
- Automatic expiration based on usage patterns

### Audit Logging
All MCP operations are logged:
- Token used
- Operation performed
- Files accessed/modified
- Timestamp and IP address

### Rate Limiting
MCP endpoints have specific rate limits:
- **Read operations:** 1000 requests per hour
- **Write operations:** 500 requests per hour
- **Path detection:** 2000 requests per hour

## Integration Examples

### Reading a Document
```typescript
const response = await fetch('/api/mcp/documents?path=/drives/project/readme.md', {
  headers: {
    'Authorization': 'Bearer mcp_abc123_xyz789'
  }
});

const document = await response.json();
console.log(document.content);
```

### Updating a Document
```typescript
const response = await fetch('/api/mcp/documents', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer mcp_abc123_xyz789',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    operation: 'replace',
    path: '/drives/project/readme.md',
    content: '# Updated README\n\nNew content here.'
  })
});
```