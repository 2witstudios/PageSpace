import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Search API",
  description: "PageSpace search API: global search, multi-drive search, mentions, and discovery.",
  path: "/docs/api/search",
  keywords: ["API", "search", "mentions", "discovery", "multi-drive"],
});

const content = `
# Search API

Global search, multi-drive search, and the mention system.

## Search

### GET /api/search

Global search across all accessible pages and content.

**Query params:** \`q\` (search query), \`type\` (page type filter), \`limit\`

**Response:**
\`\`\`json
{
  "results": [{
    "pageId": "string",
    "title": "string",
    "type": "string",
    "path": "string",
    "snippet": "string",
    "driveId": "string",
    "driveName": "string"
  }],
  "totalCount": 42
}
\`\`\`

Results are filtered by the current user's permissions.

---

### GET /api/search/multi-drive

Search across multiple drives simultaneously with advanced filtering.

**Query params:** \`q\`, \`type\`, \`driveIds\`, \`limit\`

## Mentions

### GET /api/mentions/search

Search for mentionable entities (@mentions) with cross-drive capability.

**Query params:** \`q\` (search query), \`driveId\` (optional scope)

**Response:**
\`\`\`json
{
  "pages": [{
    "id": "string",
    "title": "string",
    "type": "string",
    "path": "string"
  }],
  "users": [{
    "id": "string",
    "name": "string",
    "email": "string"
  }]
}
\`\`\`

Results include both pages and users, filtered by permissions. This powers the @mention autocomplete in documents and channels.
`;

export default function SearchApiPage() {
  return <DocsMarkdown content={content} />;
}
