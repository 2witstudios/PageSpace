/**
 * Search operations (Phase 3 task 3): `search.glob`, `search.regex`,
 * `search.multiDrive`. Old MCP tools: `glob_search`, `regex_search`,
 * `multi_drive_search` (pagespace-mcp/src/handlers/search.js).
 *
 * `glob_search`/`regex_search` route-verified against
 * `apps/web/src/app/api/drives/[driveId]/search/{glob,regex}/route.ts` GET,
 * backed by `globSearchPages`/`regexSearchPages`
 * (`packages/lib/src/services/drive-search-service.ts`). `multi_drive_search`
 * route-verified against `apps/web/src/app/api/search/multi-drive/route.ts`
 * GET (docs/sdk/operations-inventory.md §3, parity rows for all three).
 *
 * Patterns are passed through verbatim — the server owns pattern safety
 * (ReDoS guards, statement timeouts); the SDK only validates request
 * *structure* (non-empty pattern, enum/bounds matching the route's own
 * clamps) and the server's response shape. Results are permission-filtered
 * server-side (per-page view checks); this SDK layer does not re-filter.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

// ---------------------------------------------------------------------------
// search.glob — GET /api/drives/:driveId/search/glob
// ---------------------------------------------------------------------------

/**
 * The route's type filter (`search/glob/route.ts`), which since #2150 derives
 * from the canonical `PageType` enum in `packages/lib/src/utils/enums.ts`
 * rather than a hand-written list — so this must be all ten members.
 *
 * It stays inlined rather than imported because the published SDK must never
 * runtime- or type-import `@pagespace/lib`: a published `.d.ts` referencing an
 * unpublished internal package would break a consumer's `tsc`. Equality with
 * the canonical enum is instead enforced at compile time by
 * `__tests__/glob-page-types-drift-guard.test.ts`.
 */
export const GLOB_SEARCH_PAGE_TYPES = [
  'FOLDER',
  'DOCUMENT',
  'CHANNEL',
  'AI_CHAT',
  'CANVAS',
  'FILE',
  'SHEET',
  'TASK_LIST',
  'CODE',
  'MACHINE',
] as const;
const globSearchPageTypeSchema = z.enum(GLOB_SEARCH_PAGE_TYPES);

/**
 * The route reads `includeTypes` with a single `searchParams.get()` call and
 * splits on `,` (`search/glob/route.ts:38,53-57`) — a repeated query key
 * (`includeTypes=A&includeTypes=B`) would silently lose every value but the
 * first. This field is therefore the wire-format comma-separated string
 * itself, not an array — `buildRequest` maps it to a single query param
 * unchanged, matching the route exactly.
 */
const includeTypesSchema = z
  .string()
  .refine(
    (value) => value.split(',').every((type) => globSearchPageTypeSchema.safeParse(type).success),
    { message: `includeTypes must be a comma-separated list drawn from: ${GLOB_SEARCH_PAGE_TYPES.join(', ')}` },
  )
  .optional();

const globSearchResultSchema = z.object({
  pageId: z.string(),
  title: z.string(),
  type: z.string(),
  semanticPath: z.string(),
  matchedOn: z.enum(['path', 'title']),
});

const globSearchOutputSchema = z.object({
  success: z.literal(true),
  driveSlug: z.string().nullable(),
  pattern: z.string(),
  results: z.array(globSearchResultSchema),
  totalResults: z.number(),
  summary: z.string(),
  stats: z.object({
    totalPagesScanned: z.number(),
    matchingPages: z.number(),
    documentTypes: z.array(z.string()),
    matchTypes: z.object({ path: z.number(), title: z.number() }),
  }),
  nextSteps: z.array(z.string()),
});

export const globSearch = defineOperation({
  name: 'search.glob',
  method: 'GET',
  path: '/api/drives/:driveId/search/glob',
  inputSchema: z.strictObject({
    driveId: z.string(),
    pattern: z.string().min(1),
    includeTypes: includeTypesSchema,
    // Route clamps to 1-200, default 100 (search/glob/route.ts:39-43); the
    // SDK rejects out-of-bounds rather than silently relying on the clamp.
    maxResults: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: globSearchOutputSchema,
  requiredScope: 'drive',
  description:
    'Find pages using glob-style patterns for titles and paths (e.g. "**/README*", "docs/**/*.md"). Results are permission-filtered.',
});

// ---------------------------------------------------------------------------
// search.regex — GET /api/drives/:driveId/search/regex
// ---------------------------------------------------------------------------

const regexSearchResultSchema = z.object({
  pageId: z.string(),
  title: z.string(),
  type: z.string(),
  semanticPath: z.string(),
  matchingLines: z.array(z.object({ lineNumber: z.number(), content: z.string() })),
  totalMatches: z.number(),
});

const regexSearchOutputSchema = z.object({
  success: z.literal(true),
  driveSlug: z.string().nullable(),
  pattern: z.string(),
  searchIn: z.string(),
  results: z.array(regexSearchResultSchema),
  totalResults: z.number(),
  summary: z.string(),
  stats: z.object({
    pagesScanned: z.number(),
    pagesWithAccess: z.number(),
    documentTypes: z.array(z.string()),
  }),
  nextSteps: z.array(z.string()),
});

export const regexSearch = defineOperation({
  name: 'search.regex',
  method: 'GET',
  path: '/api/drives/:driveId/search/regex',
  inputSchema: z.strictObject({
    driveId: z.string(),
    pattern: z.string().min(1),
    searchIn: z.enum(['content', 'title', 'both']).optional(),
    // Route clamps to 1-100, default 50 (search/regex/route.ts:36-40).
    maxResults: z.number().int().min(1).max(100).optional(),
  }),
  outputSchema: regexSearchOutputSchema,
  requiredScope: 'drive',
  description:
    'Search page content using regular expression patterns (e.g. "TODO.*urgent", "\\\\d{4}-\\\\d{2}-\\\\d{2}"). The server owns pattern safety (ReDoS guards); results are permission-filtered.',
});

// ---------------------------------------------------------------------------
// search.multiDrive — GET /api/search/multi-drive
// ---------------------------------------------------------------------------

const multiDriveSearchMatchSchema = z.object({
  pageId: z.string(),
  title: z.string(),
  type: z.string(),
  excerpt: z.string(),
});

const multiDriveSearchGroupSchema = z.object({
  driveId: z.string(),
  driveName: z.string(),
  driveSlug: z.string(),
  matches: z.array(multiDriveSearchMatchSchema),
  count: z.number(),
});

const multiDriveSearchOutputSchema = z.object({
  success: z.literal(true),
  searchQuery: z.string(),
  searchType: z.string(),
  results: z.array(multiDriveSearchGroupSchema),
  totalDrives: z.number(),
  totalMatches: z.number(),
  summary: z.string(),
  stats: z.object({
    drivesSearched: z.number(),
    drivesWithResults: z.number(),
    totalMatches: z.number(),
  }),
  nextSteps: z.array(z.string()),
});

export const multiDriveSearch = defineOperation({
  name: 'search.multiDrive',
  method: 'GET',
  path: '/api/search/multi-drive',
  inputSchema: z.strictObject({
    searchQuery: z.string().min(1),
    searchType: z.enum(['text', 'regex']).optional(),
    // Route clamps to 1-50, default 20 (search/multi-drive/route.ts:26-30).
    maxResultsPerDrive: z.number().int().min(1).max(50).optional(),
  }),
  outputSchema: multiDriveSearchOutputSchema,
  // No single driveId path param — this enumerates whatever drives the
  // caller's own principal can already access (same rationale as
  // `drives.list`, which also declares no requiredScope).
  description:
    'Search for content across all drives the caller can access. Automatically filters results based on permissions.',
});
