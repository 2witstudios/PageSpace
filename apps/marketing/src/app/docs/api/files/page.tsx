import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Files API",
  description: "PageSpace files API: upload, serving, download, processing, document conversion, and avatars.",
  path: "/docs/api/files",
  keywords: ["API", "files", "upload", "download", "processing", "avatars"],
});

const content = `
# Files API

Uploads, file serving, processing status, conversion, and avatars. Files are content-addressed by SHA-256, so identical uploads are deduplicated.

## Upload

### POST /api/upload

Upload a file into a drive, optionally creating or positioning a \`FILE\` page.

**Content-Type:** \`multipart/form-data\`

**Form fields:**
- \`file\` — the file contents (required)
- \`driveId\` — target drive (required)
- \`parentId\` — parent page ID (optional; omit for drive root)
- \`title\` — page title (optional; defaults to sanitized filename)
- \`position\` — \`"before"\` or \`"after"\` to insert relative to another sibling
- \`afterNodeId\` — sibling page ID referenced by \`position\`

**Size cap:** 20 MB by default, configurable per deployment. The processor enforces the cap and rejects larger uploads.

**Auth:** session or MCP bearer. MCP tokens scoped to specific drives can only upload into those drives. Per-user storage quota and per-tier concurrency limits are enforced.

**Response:** \`200\` or \`202\` with:
\`\`\`json
{
  "success": true,
  "page": {
    "id": "string",
    "title": "string",
    "type": "FILE",
    "fileSize": 0,
    "mimeType": "string",
    "contentHash": "string",
    "deduplicated": false
  },
  "message": "string",
  "processingStatus": "pending | processing | completed | failed",
  "storageInfo": {
    "used": 0,
    "quota": 0,
    "formattedUsed": "string",
    "formattedQuota": "string"
  }
}
\`\`\`

\`202\` indicates the processor is running text extraction, OCR, or image optimization in the background. Poll \`/api/pages/[pageId]/processing-status\` or listen for the \`page:updated\` socket event.

## Serving

### GET /api/files/[id]/view

Stream an uploaded file to the authenticated user. Verifies permissions, fetches the object from the processor, and streams it back with the right content type and caching headers.

---

### GET /api/files/[id]/download

Same as \`view\` but sets \`Content-Disposition: attachment\`.

## Conversion

### POST /api/files/[id]/convert-to-document

Convert a \`FILE\` page (with extracted text) into a \`DOCUMENT\` page. The original file is preserved; a new \`DOCUMENT\` page is created with the extracted text as content.

## Avatars

### GET /api/avatar/[userId]/[filename]

Serve a user's avatar image.

---

### POST /api/account/avatar

Upload a new avatar for the current user (\`multipart/form-data\`).

---

### DELETE /api/account/avatar

Remove the current user's avatar.
`;

export default function FilesApiPage() {
  return <DocsMarkdown content={content} />;
}
