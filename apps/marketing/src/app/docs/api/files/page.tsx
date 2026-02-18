import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Files API",
  description: "PageSpace files API: upload, serving, processing, download, and document conversion.",
  path: "/docs/api/files",
  keywords: ["API", "files", "upload", "download", "processing", "images"],
});

const content = `
# Files API

File upload, serving, processing, and conversion.

## Upload

### POST /api/upload

Upload a file to a page.

**Content-Type:** \`multipart/form-data\`

**Form fields:**
- \`file\` — The file to upload
- \`pageId\` — Target page ID (optional — creates a new FILE page if omitted)
- \`driveId\` — Target drive (required if no pageId)

**Limits:**
- Maximum file size: 100 MB
- Authenticated users only

**Processing:** Files are forwarded to the processor service for:
- Image optimization (resizing, format conversion)
- Text extraction (PDF, DOCX, etc.)
- Content-addressed storage (SHA-256 deduplication)

**Response:**
\`\`\`json
{
  "id": "string",
  "filename": "string",
  "mimeType": "string",
  "size": 12345,
  "processingStatus": "pending | processing | completed | failed"
}
\`\`\`

## Serving

### GET /api/files/[id]/view

Serve an uploaded file to authenticated users.

Verifies permissions, fetches from processor service, streams to client with appropriate content type and caching headers.

---

### GET /api/files/[id]/download

Download the original uploaded file with \`Content-Disposition: attachment\` header.

## Conversion

### GET, POST /api/files/[id]/convert-to-document

Convert a FILE page to a DOCUMENT page using the extracted text content.

The original file is preserved. A new DOCUMENT page is created with the extracted text as content.

## Avatars

### GET /api/avatar/[userId]/[filename]

Serve user avatar images.

---

### POST /api/account/avatar

Upload a new avatar image for the current user.
`;

export default function FilesApiPage() {
  return <DocsMarkdown content={content} />;
}
