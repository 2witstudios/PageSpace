import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Search API",
  description: "PageSpace search API: global search across drives, pages, and users, multi-drive search with regex, and mention autocomplete.",
  path: "/docs/api/search",
  keywords: ["API", "search", "mentions", "multi-drive", "regex"],
});

const content = `
# Search API

Global search across drives, pages, and users; multi-drive regex search; and mention autocomplete.

All routes accept session or MCP bearer auth. Results are filtered to what the caller can access.

## Global search

### GET /api/search

Search drives, pages, and users. Multi-word queries require every word to be present (in any order) in the title; content matches are more lenient.

**Query params:**
- \`q\` — query string (minimum 2 non-whitespace characters)
- \`limit\` — 1-50, default 20

**Response:**
\`\`\`json
{
  "results": [{
    "id": "string",
    "title": "string",
    "type": "page | drive | user",
    "pageType": "DOCUMENT | CODE | ...",
    "driveId": "string",
    "driveName": "string",
    "description": "string",
    "avatarUrl": "string | null",
    "matchLocation": "title | content | both",
    "relevanceScore": 0
  }]
}
\`\`\`

If the trimmed query is shorter than 2 characters, the route returns an empty result set (\`200\`).

## Multi-drive search

### GET /api/search/multi-drive

Search content across every drive the caller can access (filtered by MCP token scope).

**Query params:**
- \`searchQuery\` — query string (required)
- \`searchType\` — \`text\` (default) or \`regex\`
- \`maxResultsPerDrive\` — 1-50, default 20

**Response:**
\`\`\`json
{
  "success": true,
  "searchQuery": "string",
  "searchType": "text | regex",
  "results": [],
  "totalDrives": 0,
  "totalMatches": 0,
  "summary": "Found N matches across M drives",
  "stats": {
    "drivesSearched": 0,
    "drivesWithResults": 0,
    "totalMatches": 0
  }
}
\`\`\`

## Mentions

### GET /api/mentions/search

Search for entities you can \`@\`-mention — pages, users, and agents. Powers the autocomplete in documents and channels.

**Query params:**
- \`q\` — query string
- \`driveId\` — scope results to a single drive
- \`crossDrive\` — \`true\` to return matches from every accessible drive
- \`types\` — comma-separated filter, e.g. \`pages,users,agents\`
`;

export default function SearchApiPage() {
  return <DocsMarkdown content={content} />;
}
